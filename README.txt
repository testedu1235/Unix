Cara run di Termux:

1. pkg update && pkg upgrade -y
2. pkg install nodejs unzip -y
3. unzip unixpunks.zip
4. cd unixpunks
5. nano .env
6. Isi PRIVATE_KEY dengan private key wallet kamu.
   Format wajib: 0x + 64 karakter hex.
   Jangan pakai seed phrase / address wallet.
7. npm install
8. node bot.js

Atau:
chmod +x start.sh
./start.sh

Catatan keamanan:
- Jangan share private key.
- Pakai wallet khusus bot dengan saldo secukupnya.
- RPC sudah diisi: https://ethereum-rpc.publicnode.com
