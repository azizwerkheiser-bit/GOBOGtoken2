(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const ABI_VAULT = [
    "function token() view returns (address)",
    "function beneficiary() view returns (address)",
    "function start() view returns (uint64)",
    "function cliffTime() view returns (uint64)",
    "function duration() view returns (uint64)",
    "function endTime() view returns (uint64)",
    "function released() view returns (uint256)",
    "function releasable() view returns (uint256)",
    "function release()"
  ];

  const ABI_ERC20 = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
  ];

  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function fmtTs(epoch) {
    if (!epoch) return "-";
    const d = new Date(Number(epoch) * 1000);
    return d.toLocaleString("id-ID", { timeZoneName: "short" });
  }

  function shortAddr(a) {
    if (!a || a.length < 10) return a || "-";
    return a.slice(0, 6) + "…" + a.slice(-4);
  }

  let cfg, bucketKey, vaultAddr;
  let provider, signer, walletAddress;
  let vaultRead, vaultWrite, tokenRead;
  let tokenDecimals = 18, tokenSymbol = "TOKEN";

  async function loadConfigSafe() {
    // Pakai loader yang kamu punya
    if (typeof window.loadGobogConfig === "function") return await window.loadGobogConfig();
    if (typeof window.loadGobogConfig === "undefined" && typeof loadGobogConfig === "function") return await loadGobogConfig();
    throw new Error("Config loader not found. Pastikan app-config.js expose loadGobogConfig().");
  }

  async function init() {
    cfg = await loadConfigSafe();

    bucketKey = (qs("bucket") || "team").toLowerCase();
    const buckets = cfg.VESTING_VAULTS || {};
    if (!buckets[bucketKey] || !buckets[bucketKey].address) {
      $("statusBox").className = "warn";
      $("statusBox").textContent =
        `Bucket "${bucketKey}" belum diset di config.json. Set VESTING_VAULTS.${bucketKey}.address dulu.`;
      $("subtitle").textContent = "Missing vault address in config.json";
      return;
    }

    vaultAddr = buckets[bucketKey].address;
    $("title").textContent = buckets[bucketKey].label || `Vault: ${bucketKey}`;
    $("subtitle").textContent = `Bucket: ${bucketKey}`;

    $("vaultAddr").textContent = vaultAddr;

    if (!window.ethereum) {
      $("statusBox").className = "warn";
      $("statusBox").textContent = "Wallet provider tidak ditemukan. Install MetaMask / pakai browser wallet.";
      return;
    }

    provider = new ethers.BrowserProvider(window.ethereum);

    // read-only contracts (bisa sebelum connect)
    vaultRead = new ethers.Contract(vaultAddr, ABI_VAULT, provider);

    // preload token info
    const tokenAddr = await vaultRead.token();
    $("tokenAddr").textContent = tokenAddr;

    tokenRead = new ethers.Contract(tokenAddr, ABI_ERC20, provider);
    try { tokenDecimals = await tokenRead.decimals(); } catch {}
    try { tokenSymbol = await tokenRead.symbol(); } catch {}
    $("sym").textContent = tokenSymbol;

    await refreshReadOnly();
    wireUI();
  }

  function wireUI() {
    $("btnConnect").onclick = connectWallet;
    $("btnClaim").onclick = claimRelease;

    // auto refresh tiap 10 detik
    setInterval(() => refreshReadOnly().catch(() => {}), 10000);
  }

  async function connectWallet() {
    try {
      await provider.send("eth_requestAccounts", []);
      signer = await provider.getSigner();
      walletAddress = await signer.getAddress();
      $("walletAddr").textContent = walletAddress;

      const net = await provider.getNetwork();
      $("netName").textContent = `${cfg.CHAIN_NAME || "Network"} (chainId=${net.chainId})`;

      // Optional: cek chainId
      if (cfg.CHAIN_ID && Number(net.chainId) !== Number(cfg.CHAIN_ID)) {
        $("statusBox").className = "warn";
        $("statusBox").textContent =
          `Network salah. Harus chainId=${cfg.CHAIN_ID}, sekarang chainId=${net.chainId}.`;
      } else {
        $("statusBox").className = "ok";
        $("statusBox").textContent = "Wallet connected. Ready.";
      }

      vaultWrite = new ethers.Contract(vaultAddr, ABI_VAULT, signer);

      // Enable claim hanya kalau wallet == beneficiary (UI safety)
      const ben = await vaultRead.beneficiary();
      const isBen = walletAddress.toLowerCase() === ben.toLowerCase();
      $("btnClaim").disabled = !isBen;

      await refreshReadOnly();
    } catch (e) {
      $("statusBox").className = "warn";
      $("statusBox").textContent = "Connect gagal: " + (e?.message || e);
    }
  }

  async function refreshReadOnly() {
    if (!vaultRead) return;

    const [ben, start, cliff, end, dur, rel, rels] = await Promise.all([
      vaultRead.beneficiary(),
      vaultRead.start(),
      vaultRead.cliffTime(),
      vaultRead.endTime(),
      vaultRead.duration(),
      vaultRead.released(),
      vaultRead.releasable()
    ]);

    $("beneficiaryAddr").textContent = ben;
    $("startTs").textContent = `${start}  (${fmtTs(start)})`;
    $("cliffTs").textContent = `${cliff}  (${fmtTs(cliff)})`;
    $("endTs").textContent = `${end}  (${fmtTs(end)})`;
    $("durDays").textContent = `${Number(dur) / 86400} days`;

    // balances
    let vaultBalRaw = 0n;
    try { vaultBalRaw = await tokenRead.balanceOf(vaultAddr); } catch {}
    $("vaultBal").textContent = `${ethers.formatUnits(vaultBalRaw, tokenDecimals)} ${tokenSymbol}`;
    $("released").textContent = `${ethers.formatUnits(rel, tokenDecimals)} ${tokenSymbol}`;
    $("releasable").textContent = `${ethers.formatUnits(rels, tokenDecimals)} ${tokenSymbol}`;

    // If connected, keep claim enabled only for beneficiary
    if (walletAddress && $("btnClaim")) {
      const isBen = walletAddress.toLowerCase() === ben.toLowerCase();
      $("btnClaim").disabled = !isBen;
    }
  }

  async function claimRelease() {
    try {
      if (!vaultWrite) throw new Error("Belum connect wallet.");
      $("btnClaim").disabled = true;
      $("statusBox").className = "warn";
      $("statusBox").textContent = "Sending release()…";

      const tx = await vaultWrite.release();
      $("statusBox").textContent = `TX sent: ${tx.hash}`;

      await tx.wait();

      $("statusBox").className = "ok";
      $("statusBox").textContent = "Claim sukses. Refreshing…";
      await refreshReadOnly();
    } catch (e) {
      $("statusBox").className = "warn";
      $("statusBox").textContent = "Claim gagal: " + (e?.shortMessage || e?.message || e);
    } finally {
      // re-enable based on beneficiary check
      try { await refreshReadOnly(); } catch {}
    }
  }

  // start
  try {
    await init();
  } catch (e) {
    $("statusBox").className = "warn";
    $("statusBox").textContent = "Init error: " + (e?.message || e);
  }
})();
