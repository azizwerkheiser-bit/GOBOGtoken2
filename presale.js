(async function () {
  const $ = (id) => document.getElementById(id);

  const logEl = $("log");
  const log = (s) => {
    if (!logEl) return;
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    logEl.textContent = `[${ts}] ${s}\n` + logEl.textContent;
  };

  function formatDDHHMMSS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const dd = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(dd)}:${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }

  function fmt(x, d) {
    try { return ethers.formatUnits(x, d); } catch (_) { return "-"; }
  }
  function parse(x, d) {
    return ethers.parseUnits(x, d);
  }

  function nfmt(num, digits = 2) {
    const x = Number(num);
    if (!isFinite(x)) return "-";
    return x.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  // ---- load config ----
  let cfg;
  try {
    cfg = await loadGobogConfig();
  } catch (e) {
    const msg = e?.message || String(e);
    log("Config error: " + msg);
    alert("Failed to load config.json. Make sure it exists and is valid JSON.\n\n" + msg);
    return;
  }

  const PRESALE_CAP = Number(cfg.PRESALE_TOKEN_CAP || 500000);

  // ---- explorer link ----
  const ex = $("explorerPresale");
  if (ex) {
    const base = (cfg.EXPLORER_BASE || "").replace(/\/$/, "");
    ex.href = cfg.PRESALE_EXPLORER_URL || (base ? `${base}/address/${cfg.PRESALE_ADDRESS}` : "#");
  }

  // ---- ABI ----
  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)"
  ];

  const presaleAbi = [
    "function buy(uint256 usdtAmount) external",
    "function claim() external",
    "function finalize() external",
    "function claimable(address user) view returns (uint256)",
    "function endTime() view returns (uint256)",
    "function canFinalizeNow() view returns (bool)"
  ];

  // Optional stats ABI (kalau kontrak kamu punya)
  const presaleStatsAbi = [
    "function totalSold() view returns (uint256)",
    "function tokensSold() view returns (uint256)",
    "function sold() view returns (uint256)"
  ];

  // ---- Phase UI ----
  function buildTimeline() {
    const phases = cfg.PHASES || [];
    const start = Number(cfg.PRESALE_START_TIME || 0);
    if (!start || phases.length === 0) return { start, timeline: [] };

    let t = start;
    const timeline = phases.map((p) => {
      const durDays = Number(p.duration_days || 7);
      const durSec = Math.max(1, Math.floor(durDays * 86400));
      const seg = { ...p, start: t, end: t + durSec, durDays };
      t += durSec;
      return seg;
    });

    return { start, timeline };
  }

  function getActivePhase(now) {
    const { start, timeline } = buildTimeline();
    if (!start || timeline.length === 0) return { idx: -1, phase: null, phaseEnd: start || 0, timeline };

    const totalEnd = timeline[timeline.length - 1].end;

    if (now < start) return { idx: -1, phase: null, phaseEnd: start, timeline };

    const idx = timeline.findIndex((seg) => now >= seg.start && now < seg.end);
    if (idx === -1 && now >= totalEnd) return { idx: timeline.length, phase: null, phaseEnd: totalEnd, timeline };

    return { idx, phase: timeline[idx], phaseEnd: timeline[idx].end, timeline };
  }

  function renderPhases() {
    const listEl = $("phaseList");
    const activeEl = $("phaseActive");
    const cdEl = $("phaseCountdown");
    if (!listEl || !activeEl || !cdEl) return;

    const now = Math.floor(Date.now() / 1000);
    const info = getActivePhase(now);

    if (!cfg.PRESALE_START_TIME || !info.timeline.length) {
      activeEl.textContent = "Not configured";
      cdEl.textContent = "--:--:--:--";
      listEl.innerHTML = "";
      return;
    }

    if (info.idx < 0) {
      activeEl.textContent = "Not started";
      cdEl.textContent = formatDDHHMMSS(info.phaseEnd - now);
    } else if (info.idx >= info.timeline.length) {
      activeEl.textContent = "Ended (waiting for finalize)";
      cdEl.textContent = formatDDHHMMSS(info.phaseEnd - now);
    } else {
      const p = info.phase;
      activeEl.textContent = `${p.name} • 1 USDT = ${p.gobg_per_1_usdt} GOBG`;
      cdEl.textContent = formatDDHHMMSS(info.phaseEnd - now);
    }

    listEl.innerHTML = info.timeline.map((p, i) => {
      let cls = "future";
      if (info.idx >= info.timeline.length) cls = "past";
      else if (i < info.idx) cls = "past";
      else if (i === info.idx) cls = "current";
      if (info.idx < 0) cls = "future";

      const isFuture = cls === "future";
      const shownTokensPerUsdt = isFuture ? "X.XXXX" : p.gobg_per_1_usdt;
      const shownUsdtPerGobg = isFuture ? "X.XXXX" : p.usdt_per_gobg;

      return `
        <div class="phase ${cls}">
          <div class="left">
            <div class="name">${p.name}</div>
            <div class="meta">${p.durDays} days • 1 USDT = ${shownTokensPerUsdt} GOBG</div>
          </div>
          <div class="price">${shownUsdtPerGobg} USDT / GOBG</div>
        </div>
      `;
    }).join("");
  }

  renderPhases();
  setInterval(renderPhases, 1000);

  function getUiTokensPerUsdt() {
    const now = Math.floor(Date.now() / 1000);
    const info = getActivePhase(now);
    if (info.idx >= 0 && info.idx < info.timeline.length) {
      const v = Number(info.phase?.gobg_per_1_usdt);
      if (isFinite(v) && v > 0) return v;
    }
    return 15;
  }

  // ---- Wallet/Contracts state ----
  let eip1193 = null;
  let provider = null;
  let signer = null;
  let userAddr = null;
  let usdt = null;
  let presale = null;
  let wcProvider = null;

  // Trust deep-link flag
  let trustDeepLinkNext = false;

  function getWCGlobal() {
    return window.EthereumProvider || window.WalletConnectEthereumProvider;
  }

  async function connectWithEIP1193(p, label) {
    eip1193 = p;
    provider = new ethers.BrowserProvider(eip1193);

    try { await provider.send("eth_requestAccounts", []); } catch (_) {}

    signer = await provider.getSigner();
    userAddr = await signer.getAddress();
    $("wallet").textContent = userAddr;

    const net = await provider.getNetwork();
    $("netName").textContent = `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${Number(net.chainId)} • via: ${label}`;

    usdt = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, signer);
    presale = new ethers.Contract(cfg.PRESALE_ADDRESS, presaleAbi, signer);

    log("Connected: " + userAddr);
    await refresh();
    await refreshGlobalStats(); // <-- biar bar langsung update setelah connect
  }

  async function connectInjectedOnly() {
    if (!window.ethereum) throw new Error("Injected wallet tidak ditemukan. Coba buka lewat DApp Browser (Trust/MetaMask) atau pakai extension di desktop.");
    await connectWithEIP1193(window.ethereum, "Injected");
  }

  async function ensureWalletConnectProvider() {
    const WC = getWCGlobal();
    if (!WC) throw new Error("WalletConnect belum ke-load.");
    if (!cfg.WALLETCONNECT_PROJECT_ID) throw new Error("Missing WALLETCONNECT_PROJECT_ID in config.json");
    if (!cfg.RPC_URL) throw new Error("Missing RPC_URL in config.json");

    if (!wcProvider) {
      wcProvider = await WC.init({
        projectId: cfg.WALLETCONNECT_PROJECT_ID,
        chains: [Number(cfg.CHAIN_ID)],
        rpcMap: { [Number(cfg.CHAIN_ID)]: cfg.RPC_URL },
        showQrModal: true,
        metadata: {
          name: `${cfg.PROJECT_NAME || "GOBOG"} Presale`,
          description: "GOBOG presale dApp",
          url: cfg.SITE_URL || window.location.origin,
          icons: [cfg.SITE_ICON || ""].filter(Boolean)
        }
      });

      wcProvider.on?.("display_uri", (uri) => {
        if (trustDeepLinkNext) {
          trustDeepLinkNext = false;
          const tw = "https://link.trustwallet.com/wc?uri=" + encodeURIComponent(uri);
          log("Opening TrustWallet…");
          window.location.href = tw;
        }
      });

      wcProvider.on("disconnect", () => log("WalletConnect disconnected"));
    }

    return wcProvider;
  }

  async function connectWalletConnectQR() {
    const p = await ensureWalletConnectProvider();
    await p.connect();
    await connectWithEIP1193(p, "WalletConnect");
  }

  async function connectTrustWalletApp() {
    trustDeepLinkNext = true;
    const p = await ensureWalletConnectProvider();
    await p.connect();
    await connectWithEIP1193(p, "WalletConnect (TrustWallet)");
  }

  // ---- Global stats (Raised/Sold) read-only via RPC ----
  let rpc = null;
  let usdtRead = null;
  let tokenRead = null;
  let presaleRead = null;

  try {
    if (cfg.RPC_URL) {
      rpc = new ethers.JsonRpcProvider(cfg.RPC_URL);
      usdtRead = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, rpc);

      if (cfg.TOKEN_ADDRESS) {
        tokenRead = new ethers.Contract(cfg.TOKEN_ADDRESS, erc20Abi, rpc);
      }

      // try optional sold() view (kalau kontrak punya)
      presaleRead = new ethers.Contract(cfg.PRESALE_ADDRESS, [...presaleAbi, ...presaleStatsAbi], rpc);
    }
  } catch (e) {
    log("RPC init error: " + (e?.message || String(e)));
  }

  async function trySoldFromContract() {
    if (!presaleRead) return null;
    const fns = ["totalSold", "tokensSold", "sold"];
    for (const fn of fns) {
      try {
        const v = await presaleRead[fn]();
        return { method: `presale.${fn}()`, raw: v };
      } catch (_) {}
    }
    return null;
  }

  async function refreshGlobalStats() {
    try {
      if (!usdtRead) return;

      // Raised = USDT balance di kontrak presale (karena USDT ditahan sampai finalize)
      const raisedRaw = await usdtRead.balanceOf(cfg.PRESALE_ADDRESS);
      const raised = parseFloat(ethers.formatUnits(raisedRaw, cfg.USDT_DECIMALS));

      let sold = null;
      let soldHow = "";

      // 1) kalau kontrak punya totalSold()
      const soldFromView = await trySoldFromContract();
      if (soldFromView) {
        sold = parseFloat(ethers.formatUnits(soldFromView.raw, cfg.TOKEN_DECIMALS));
        soldHow = soldFromView.method;
      }

      // 2) fallback: cap - token balance di kontrak presale
      if (sold === null && tokenRead && PRESALE_CAP > 0) {
        const remainRaw = await tokenRead.balanceOf(cfg.PRESALE_ADDRESS);
        const remain = parseFloat(ethers.formatUnits(remainRaw, cfg.TOKEN_DECIMALS));
        sold = Math.max(0, PRESALE_CAP - remain);
        soldHow = "cap - token.balanceOf(presale)";
      }

      // 3) fallback terakhir (kalau kamu punya rate fixed dan mau): sold ≈ raised * rate
      if (sold === null && Number(cfg.BASE_RATE_GOBG_PER_USDT || 0) > 0) {
        const rate = Number(cfg.BASE_RATE_GOBG_PER_USDT);
        sold = raised * rate;
        soldHow = `raised * ${rate}`;
      }

      // ---- existing stats widgets (optional) ----
      const raisedEl = $("raised");
      const soldEl = $("sold");
      const barEl = $("soldBar");
      const metaEl = $("soldMeta");

      if (raisedEl) raisedEl.textContent = `${nfmt(raised, 2)} USDT`;

      // ---- NEW: Buy card widgets ----
      const buySoldText = $("buySoldText");
      const buySoldBar  = $("buySoldBar");
      const buyRaisedText = $("buyRaisedText");

      if (buyRaisedText) buyRaisedText.textContent = `Raised: ${nfmt(raised, 2)} USDT`;

      if (sold === null) {
        if (soldEl) soldEl.textContent = `- / ${PRESALE_CAP.toLocaleString()}`;
        if (barEl) barEl.style.width = "0%";

        if (buySoldText) buySoldText.textContent = `- / ${PRESALE_CAP.toLocaleString()}`;
        if (buySoldBar) buySoldBar.style.width = "0%";
      } else {
        const pct = PRESALE_CAP > 0 ? Math.min(100, (sold / PRESALE_CAP) * 100) : 0;

        if (soldEl) soldEl.textContent =
          `${nfmt(sold, 2)} / ${PRESALE_CAP.toLocaleString()} (${pct.toFixed(2)}%)`;
        if (barEl) barEl.style.width = pct.toFixed(2) + "%";

        if (buySoldText) buySoldText.textContent =
          `${nfmt(sold, 2)} / ${PRESALE_CAP.toLocaleString()} (${pct.toFixed(2)}%)`;
        if (buySoldBar) buySoldBar.style.width = pct.toFixed(2) + "%";
      }

      if (metaEl) {
        if (soldHow) metaEl.textContent = `Stats mode: ${soldHow} • (Raised dari USDT balance presale).`;
        else metaEl.textContent = `Raised dari USDT balance presale. Sold butuh token balance di presale atau fungsi totalSold().`;
      }
    } catch (e) {
      log("Global stats error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function refresh() {
    if (!signer) return;
    try {
      const [bal, cl, end] = await Promise.all([
        usdt.balanceOf(userAddr),
        presale.claimable(userAddr),
        presale.endTime()
      ]);

      $("usdtBal").textContent = fmt(bal, cfg.USDT_DECIMALS);
      $("claimable").textContent = fmt(cl, cfg.TOKEN_DECIMALS);
      $("ends").textContent = new Date(Number(end) * 1000).toLocaleString();
    } catch (e) {
      log("Refresh error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function approveUSDT() {
    const amtStr = ($("amt").value || "").trim();
    if (!amtStr) return alert("Enter USDT amount first.");
    const amt = parse(amtStr, cfg.USDT_DECIMALS);

    try {
      const allowance = await usdt.allowance(userAddr, cfg.PRESALE_ADDRESS);
      if (allowance >= amt) {
        log("Allowance already sufficient.");
        return;
      }
      const tx = await usdt.approve(cfg.PRESALE_ADDRESS, amt);
      log("Approve tx: " + tx.hash);
      await tx.wait();
      log("Approve confirmed.");
      await refresh();
      await refreshGlobalStats();
    } catch (e) {
      log("Approve error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function buy() {
    const amtStr = ($("amt").value || "").trim();
    if (!amtStr) return alert("Enter USDT amount first.");
    const amt = parse(amtStr, cfg.USDT_DECIMALS);

    try {
      const allowance = await usdt.allowance(userAddr, cfg.PRESALE_ADDRESS);
      if (allowance < amt) {
        log("Allowance too low. Click Approve first.");
        return;
      }
      const tx = await presale.buy(amt);
      log("Buy tx: " + tx.hash);
      await tx.wait();
      log("Buy confirmed.");
      await refresh();
      await refreshGlobalStats();
    } catch (e) {
      log("Buy error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function claim() {
    try {
      const tx = await presale.claim();
      log("Claim tx: " + tx.hash);
      await tx.wait();
      log("Claim confirmed.");
      await refresh();
      await refreshGlobalStats();
    } catch (e) {
      log("Claim error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function finalize() {
    try {
      const ok = await presale.canFinalizeNow();
      if (!ok) {
        log("Cannot finalize yet (time not ended / not sold out).");
        return;
      }
      const tx = await presale.finalize();
      log("Finalize tx: " + tx.hash);
      await tx.wait();
      log("Finalize confirmed.");
      await refresh();
      await refreshGlobalStats();
    } catch (e) {
      log("Finalize error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  function updateEstimate() {
    const amtStr = ($("amt").value || "").trim();
    if (!amtStr) { $("estOut").textContent = "Estimated output: -"; return; }

    const x = Number(amtStr);
    if (!isFinite(x) || x <= 0) { $("estOut").textContent = "Estimated output: -"; return; }

    const rate = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? getUiTokensPerUsdt() : 15;
    const out = x * rate;
    const tag = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? "UI phase rate" : "Base rate";
    $("estOut").textContent = `Estimated output (${tag}): ${out.toLocaleString()} GOBG`;
  }

  // ---- Connect Modal ----
  const backdrop = $("cmBackdrop");
  const btnInjected = $("cmInjected");
  const btnWC = $("cmWC");
  const btnTrust = $("cmTrust");
  const btnCancel = $("cmCancel");

  function openConnectModal() {
    if (!backdrop) return;
    if (btnInjected) btnInjected.disabled = !window.ethereum;
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeConnectModal() {
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

  backdrop?.addEventListener("click", (e) => {
    if (e.target === backdrop) closeConnectModal();
  });
  btnCancel?.addEventListener("click", closeConnectModal);

  btnInjected?.addEventListener("click", async () => {
    closeConnectModal();
    try { await connectInjectedOnly(); }
    catch (err) {
      const msg = err?.message || String(err);
      log("Connect error: " + msg);
      alert("Connect failed: " + msg);
    }
  });

  btnWC?.addEventListener("click", async () => {
    closeConnectModal();
    try { await connectWalletConnectQR(); }
    catch (err) {
      const msg = err?.message || String(err);
      log("Connect error: " + msg);
      alert("Connect failed: " + msg);
    }
  });

  btnTrust?.addEventListener("click", async () => {
    closeConnectModal();
    try { await connectTrustWalletApp(); }
    catch (err) {
      const msg = err?.message || String(err);
      log("Connect error: " + msg);
      alert("Connect failed: " + msg);
    }
  });

  // ---- bind UI ----
  $("connectBtn")?.addEventListener("click", async (e) => {
    e.preventDefault();
    openConnectModal();
  });

  $("approveBtn")?.addEventListener("click", approveUSDT);
  $("buyBtn")?.addEventListener("click", buy);
  $("claimBtn")?.addEventListener("click", claim);
  $("finalizeBtn")?.addEventListener("click", finalize);
  $("amt")?.addEventListener("input", updateEstimate);

  // refresh loops
  setInterval(() => { if (signer) refresh(); }, 10000);
  setInterval(() => { refreshGlobalStats(); }, 10000);

  // initial
  refreshGlobalStats();
  log("UI ready.");
})();
