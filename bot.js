require("dotenv").config();
const https = require("https");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC_URL) {
  console.error("Missing RPC_URL in .env");
  process.exit(1);
}

if (!PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY.trim())) {
  console.error("Invalid PRIVATE_KEY in .env. Use 0x + 64 hex characters, no quotes/spaces.");
  process.exit(1);
}

const CONTRACT = "0x9E464d954E07abeD84081F399feE729FF99f8f93";
const ABI = [
  "function mint(bytes32 mintCode, bytes signature) payable",
  "function totalMinted() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "event Minted(address indexed minter, uint256 indexed tokenId, bytes32 indexed mintCodeHash)",
  "error MintCodeAlreadyUsed()",
  "error InvalidSignature()",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY.trim(), provider);
const contract = new ethers.Contract(CONTRACT, ABI, wallet);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiPost(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "unixpunks.xyz",
        path: "/api/" + path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
        timeout: 10000,
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch {
            resolve({ ok: false, error: "parse_error", raw: b });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (e) =>
      resolve({ ok: false, error: "network_error", message: e.message })
    );
    req.write(data);
    req.end();
  });
}

function apiGet(path) {
  return new Promise((resolve) => {
    https
      .get("https://unixpunks.xyz/api/" + path, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function getSignature(mintCode) {
  while (true) {
    console.log("  Requesting signature...");
    const res = await apiPost("sign-mint-code", {
      mintCode,
      wallet: wallet.address,
    });

    if (res.ok) {
      return { signature: res.signature, priceWei: res.priceWei };
    }

    if (res.error === "rate_limit" || res.error === "rate_limit_wallet") {
      const waitMs = (res.retryInMs || 5000) + 500;
      console.log(`  Rate limited, waiting ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Sign failed: ${res.error || JSON.stringify(res)}`);
  }
}

async function sendMintTx(mintCode, signature, priceWei) {
  console.log("  Sending mint tx...");
  const tx = await contract.mint(mintCode, signature, {
    value: BigInt(priceWei),
  });
  console.log("  TX hash:", tx.hash);
  console.log("  Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log("  Confirmed in block:", receipt.blockNumber);

  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === "Minted") {
        console.log("  Token ID:", parsed.args.tokenId.toString());
      }
    } catch {}
  }
  return receipt;
}

async function huntAndMint() {
  console.log("Wallet:", wallet.address);
  console.log("Contract:", CONTRACT);

  const balance = await provider.getBalance(wallet.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance < ethers.parseEther("0.002")) {
    console.log("WARNING: Low balance! Need at least 0.001111 ETH + gas");
  }

  let schedule;
  while (true) {
    schedule = await apiGet("schedule");
    if (schedule && schedule.activeBatch) break;
    process.stdout.write(`\r[${new Date().toLocaleTimeString()}] No active batch — waiting...`);
    await sleep(1000);
  }
  console.log(`\n[${new Date().toLocaleTimeString()}] Batch ${schedule.activeBatch} is LIVE! GO GO GO`);

  const batch = schedule.windows.find((w) => w.batch === schedule.activeBatch);
  const { tsRangeStart, tsRangeEnd, consumedCount, timestampsCount } = batch;
  const remaining = timestampsCount - consumedCount;

  console.log(`\nBatch ${schedule.activeBatch} | Range: ${tsRangeStart}-${tsRangeEnd}`);
  console.log(`Valid: ${timestampsCount} | Claimed: ${consumedCount} | Left: ${remaining}`);
  console.log("---\n");

  const allTimestamps = [];
  for (let t = tsRangeStart; t <= tsRangeEnd; t++) allTimestamps.push(t);
  shuffle(allTimestamps);

  let attempt = 0;

  for (const ts of allTimestamps) {
    attempt++;

    while (true) {
      process.stdout.write(`[${attempt}] ts=${ts} `);
      const result = await apiPost("find-mint-code", {
        timestamp: ts,
        wallet: wallet.address,
      });

      if (result.ok) {
        console.log(">>> HIT!");
        console.log("  mintCode:", result.mintCode);

        try {
          const { signature, priceWei } = await getSignature(result.mintCode);
          console.log("  Got signature, price:", priceWei, "wei");
          await sendMintTx(result.mintCode, signature, priceWei);
          console.log("\n=== MINT SUCCESSFUL! ===\n");
          return;
        } catch (err) {
          console.error("  Mint failed:", err.message || err);
          console.log("  mintCode was:", result.mintCode);
          console.log("  Continuing hunt for another timestamp...\n");
          break;
        }
      }

      if (result.error === "rate_limit" || result.error === "rate_limit_wallet") {
        const waitMs = result.retryInMs || 5000;
        process.stdout.write(`rate-limited ${Math.ceil(waitMs / 1000)}s\r`);
        await sleep(waitMs);
        continue;
      }

      if (result.error === "network_error" || result.error === "timeout") {
        process.stdout.write("net err, retry 2s\r");
        await sleep(2000);
        continue;
      }

      if (result.error === "invalid_timestamp") {
        console.log("miss");
      } else if (result.error === "timestamp_already_used") {
        console.log("claimed");
      } else if (result.error === "timestamp_already_issued") {
        console.log("issued");
      } else if (result.error === "no_active_batch") {
        console.log("Batch closed!");
        return;
      } else {
        console.log(result.error || "unknown");
      }
      break;
    }

    await sleep(150);
  }
}

huntAndMint().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
