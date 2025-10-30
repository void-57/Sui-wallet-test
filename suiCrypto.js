(function (EXPORTS) {
  "use strict";
  const suiCrypto = EXPORTS;

  // Generate a new random key
  function generateNewID() {
    var key = new Bitcoin.ECKey(false);
    key.setCompressed(true);
    return {
      floID: key.getBitcoinAddress(),
      pubKey: key.getPubKeyHex(),
      privKey: key.getBitcoinWalletImportFormat(),
    };
  }

  Object.defineProperties(suiCrypto, {
    newID: {
      get: () => generateNewID(),
    },
    hashID: {
      value: (str) => {
        let bytes = ripemd160(Crypto.SHA256(str, { asBytes: true }), {
          asBytes: true,
        });
        bytes.unshift(bitjs.pub);
        var hash = Crypto.SHA256(Crypto.SHA256(bytes, { asBytes: true }), {
          asBytes: true,
        });
        var checksum = hash.slice(0, 4);
        return bitjs.Base58.encode(bytes.concat(checksum));
      },
    },
    tmpID: {
      get: () => {
        let bytes = Crypto.util.randomBytes(20);
        bytes.unshift(bitjs.pub);
        var hash = Crypto.SHA256(Crypto.SHA256(bytes, { asBytes: true }), {
          asBytes: true,
        });
        var checksum = hash.slice(0, 4);
        return bitjs.Base58.encode(bytes.concat(checksum));
      },
    },
  });

  // --- Multi-chain Generator (BTC, FLO, SUI) ---
  suiCrypto.generateMultiChain = async function (inputWif) {
    const versions = {
      BTC: { pub: 0x00, priv: 0x80 },
      FLO: { pub: 0x23, priv: 0xa3 },
    };

    const origBitjsPub = bitjs.pub;
    const origBitjsPriv = bitjs.priv;
    const origBitjsCompressed = bitjs.compressed;
    const origCoinJsCompressed = coinjs.compressed;

    bitjs.compressed = true;
    coinjs.compressed = true;

    let privKeyHex;
    let compressed = true;

    // --- Decode input or generate new ---
    if (typeof inputWif === "string" && inputWif.trim().length > 0) {
      const trimmedInput = inputWif.trim();
      const hexOnly = /^[0-9a-fA-F]+$/.test(trimmedInput);

      if (trimmedInput.startsWith('suiprivkey1')) {
        try {
          const decoded = coinjs.bech32_decode(trimmedInput);
          if (!decoded) throw new Error('Invalid SUI private key checksum');
          const bytes = coinjs.bech32_convert(decoded.data, 5, 8, false);
          // First byte is the scheme flag (should be 0x00 for Ed25519), the rest is the 32-byte private key.
          if (bytes[0] !== 0) throw new Error('Unsupported SUI private key scheme');
          const privateKeyBytes = bytes.slice(1);
          privKeyHex = Crypto.util.bytesToHex(privateKeyBytes);
        } catch (e) {
          console.warn("Invalid SUI private key, generating new key:", e);
          const newKey = generateNewID();
          const decode = Bitcoin.Base58.decode(newKey.privKey);
          const keyWithVersion = decode.slice(0, decode.length - 4);
          let key = keyWithVersion.slice(1);
          if (key.length >= 33 && key[key.length - 1] === 0x01)
            key = key.slice(0, key.length - 1);
          privKeyHex = Crypto.util.bytesToHex(key);
        }
      } else if (hexOnly && (trimmedInput.length === 64 || trimmedInput.length === 128)) {
        privKeyHex =
          trimmedInput.length === 128 ? trimmedInput.substring(0, 64) : trimmedInput;
      } else {
        try {
          // Assume Bitcoin/FLO WIF
          const decode = Bitcoin.Base58.decode(trimmedInput);
          const keyWithVersion = decode.slice(0, decode.length - 4);
          let key = keyWithVersion.slice(1);
          if (key.length >= 33 && key[key.length - 1] === 0x01) {
            key = key.slice(0, key.length - 1);
            compressed = true;
          }
          privKeyHex = Crypto.util.bytesToHex(key);
        } catch (e) {
          console.warn("Invalid WIF, generating new key:", e);
          const newKey = generateNewID();
          const decode = Bitcoin.Base58.decode(newKey.privKey);
          const keyWithVersion = decode.slice(0, decode.length - 4);
          let key = keyWithVersion.slice(1);
          if (key.length >= 33 && key[key.length - 1] === 0x01)
            key = key.slice(0, key.length - 1);
          privKeyHex = Crypto.util.bytesToHex(key);
        }
      }
    } else {
      // Generate new key if no input
      const newKey = generateNewID();
      const decode = Bitcoin.Base58.decode(newKey.privKey);
      const keyWithVersion = decode.slice(0, decode.length - 4);
      let key = keyWithVersion.slice(1);
      if (key.length >= 33 && key[key.length - 1] === 0x01)
        key = key.slice(0, key.length - 1);
      privKeyHex = Crypto.util.bytesToHex(key);
    }

    // --- Derive addresses for each chain ---
    const result = { BTC: {}, FLO: {}, SUI: {} };

    // BTC
    bitjs.pub = versions.BTC.pub;
    bitjs.priv = versions.BTC.priv;
    const pubKeyBTC = bitjs.newPubkey(privKeyHex);
    result.BTC.address = coinjs.bech32Address(pubKeyBTC).address;
    result.BTC.privateKey = bitjs.privkey2wif(privKeyHex);

    // FLO
    bitjs.pub = versions.FLO.pub;
    bitjs.priv = versions.FLO.priv;
    const pubKeyFLO = bitjs.newPubkey(privKeyHex);
    result.FLO.address = bitjs.pubkey2address(pubKeyFLO);
    result.FLO.privateKey = bitjs.privkey2wif(privKeyHex);

    // --- SUI ---

    try {
      const privBytes = Crypto.util.hexToBytes(privKeyHex.substring(0, 64));
      const seed = new Uint8Array(privBytes.slice(0, 32));

      // Generate Ed25519 keypair from seed
      const keyPair = nacl.sign.keyPair.fromSeed(seed);
      const pubKey = keyPair.publicKey;

      const prefixedPubKey = new Uint8Array([0x00, ...pubKey]);

      // Hash with BLAKE2b-256
      const hash = blakejs.blake2b(prefixedPubKey, null, 32);

      // Convert to hex address
      const suiAddress = "0x" + Crypto.util.bytesToHex(hash);

      // Encode the private key in Sui's Bech32 format
      const privateKeyBytes = new Uint8Array([0x00, ...seed]);
      const words = coinjs.bech32_convert(Array.from(privateKeyBytes), 8, 5, true);
      const suiPrivateKey = coinjs.bech32_encode('suiprivkey', words);

      result.SUI.address = suiAddress;
      result.SUI.privateKey = suiPrivateKey; 
    } catch (error) {
      console.error("Error generating SUI address:", error);
      result.SUI.address = "Error generating address";
      result.SUI.privateKey = privKeyHex;
    }

    bitjs.pub = origBitjsPub;
    bitjs.priv = origBitjsPriv;
    bitjs.compressed = origBitjsCompressed;
    coinjs.compressed = origCoinJsCompressed;

    return result;
  };
})("object" === typeof module ? module.exports : (window.suiCrypto = {}));
