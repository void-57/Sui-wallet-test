const suiBlockchainAPI = {
  //  Get Balance
  async getBalance(address, coinType = "0x2::sui::SUI") {
    const res = await fetch("https://fullnode.mainnet.sui.io:443", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_getBalance",
        params: [address, coinType],
      }),
    });
    const json = await res.json();
    return json?.result?.totalBalance || 0;
  },
  // Get Transaction History
  async getTransactionHistory(
    address,
    filterType = "all",
    limit = 10,
    cursors = { from: null, to: null }
  ) {
    const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";
    cursors = cursors || { from: null, to: null };

    async function queryTx(filterType, address, limit, cursor) {
      const res = await fetch(SUI_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "suix_queryTransactionBlocks",
          params: [
            {
              filter: { [filterType]: address },
              options: { showInput: true, showEffects: true, showEvents: true },
            },
            cursor,
            limit,
            true,
          ],
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    }

    async function getTxDetails(digest, address) {
      if (!digest) return null;
      const res = await fetch(SUI_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sui_getTransactionBlock",
          params: [
            digest,
            {
              showInput: true,
              showEffects: true,
              showEvents: true,
              showBalanceChanges: true,
            },
          ],
        }),
      });
      const json = await res.json();
      const d = json.result;
      if (!d) return null;

      const from = d?.transaction?.data?.sender || "Unknown";
      let to = "Unknown";
      let amountMist = 0;

      for (const ev of d?.events || []) {
        if (
          ev.type?.includes("TransferEvent") ||
          ev.type?.includes("::coin::Transfer")
        ) {
          to = ev.parsedJson?.recipient || "Unknown";
          amountMist = Number(ev.parsedJson?.amount || 0);
          break;
        }
      }

      if (to === "Unknown" && d?.balanceChanges?.length) {
        const change = d.balanceChanges.find(
          (c) => c.owner?.AddressOwner && c.owner.AddressOwner !== from
        );
        if (change) {
          to = change.owner.AddressOwner;
          amountMist = Math.abs(Number(change.amount || 0));
        }
      }

      const amountSui = (amountMist / 1e9).toFixed(6);
      const datetime = d?.timestampMs
        ? new Date(Number(d.timestampMs)).toLocaleString()
        : "N/A";
      const timestamp = Number(d?.timestampMs || 0);
      const direction =
        from.toLowerCase() === address.toLowerCase() ? "Sent" : "Received";

      return { digest, from, to, amountSui, datetime, timestamp, direction };
    }

    try {
      let sent = { data: [], hasNextPage: false, nextCursor: null };
      let received = { data: [], hasNextPage: false, nextCursor: null };

      if (filterType === "all") {
        [sent, received] = await Promise.all([
          queryTx("FromAddress", address, limit, cursors.from),
          queryTx("ToAddress", address, limit, cursors.to),
        ]);
      } else if (filterType === "sent") {
        sent = await queryTx("FromAddress", address, limit, cursors.from);
      } else if (filterType === "received") {
        received = await queryTx("ToAddress", address, limit, cursors.to);
      } else {
        throw new Error("Invalid filter type specified.");
      }

      const allRaw = [...(sent.data || []), ...(received.data || [])];
      const unique = Array.from(
        new Map(allRaw.map((tx) => [tx.digest, tx])).values()
      );

      const detailed = (
        await Promise.all(unique.map((tx) => getTxDetails(tx.digest, address)))
      ).filter(Boolean);

      detailed.sort((a, b) => b.timestamp - a.timestamp);

      const nextCursor = {
        from: sent.nextCursor || null,
        to: received.nextCursor || null,
      };

      const hasNextPage = sent.hasNextPage || received.hasNextPage;

      return { txs: detailed, hasNextPage, nextCursor };
    } catch (e) {
      console.error("Fetch error:", e);
      return {
        txs: [],
        hasNextPage: false,
        nextCursor: { from: null, to: null },
      };
    }
  },

  // SUI Transaction
  async prepareSuiTransaction(privateKey, recipientAddress, amount) {
    const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";

    if (!privateKey || !recipientAddress || !amount)
      throw new Error("Missing required parameters.");

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) throw new Error("Invalid amount specified.");

    //  Get sender's address and private key from any supported format
    const wallet = await suiCrypto.generateMultiChain(privateKey);
    const senderAddress = wallet.SUI.address;
    const suiPrivateKey = wallet.SUI.privateKey;

    //  Get sender coins
    const coinResponse = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_getCoins",
        params: [senderAddress, "0x2::sui::SUI"],
      }),
    });
    const coinJson = await coinResponse.json();
    if (coinJson.error) throw new Error(coinJson.error.message);
    const coins = coinJson.result.data;
    if (!coins.length) throw new Error("No SUI balance found.");

    const amountInMist = Math.floor(amt * 1e9).toString();

    
    const txResponse = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "unsafe_paySui",
        params: [
          senderAddress,
          [coins[0].coinObjectId], 
          [recipientAddress], 
          [amountInMist], 
          "50000000", 
        ],
      }),
    });
    const txJson = await txResponse.json();

    if (txJson.error) throw new Error(`Build failed: ${txJson.error.message}`);
    const txBytes = txJson.result.txBytes;

    //  Simulate for gas estimate
    const dryRunResponse = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_dryRunTransactionBlock",
        params: [txBytes],
      }),
    });
    const dryRunJson = await dryRunResponse.json();
    if (dryRunJson.error)
      throw new Error(`Dry run failed: ${dryRunJson.error.message}`);

    const gasUsed = dryRunJson.result.effects.gasUsed;
    const gasFee =
      parseInt(gasUsed.computationCost) +
      parseInt(gasUsed.storageCost) -
      parseInt(gasUsed.storageRebate);

    console.log(
      `Estimated Gas Fee: ${(gasFee / 1e9).toFixed(6)} SUI (${gasFee} MIST)`
    );

    return {
      senderAddress,
      suiPrivateKey,
      txBytes,
      gasFee: gasFee, 
    };
  },

  // Sign and Send SUI Transaction
  async signAndSendSuiTransaction(preparedTx) {
    const SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";

    // Sign the transaction bytes 
    const signature = await suiCrypto.sign(
      preparedTx.txBytes,
      preparedTx.suiPrivateKey
    );

    // Execute the transaction
    const response = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_executeTransactionBlock",
        params: [
          preparedTx.txBytes,
          [signature],
          null,
          "WaitForLocalExecution",
        ],
      }),
    });

    const result = await response.json();
    if (result.error) throw new Error(result.error.message);

    console.log("✅ Transaction Sent:", result.result.digest);
    return result;
  },

  // Helper to get the latest epoch for transaction expiration
  async getLatestEpoch(rpcUrl) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_getLatestSuiSystemState",
      }),
    });
    const data = await res.json();
    return parseInt(data.result.epoch, 10);
  },
};

window.suiBlockchainAPI = suiBlockchainAPI;
