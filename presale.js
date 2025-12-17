(async function () {
  const $ = (id) => document.getElementById(id);

  const logEl = $("log");
  const log = (s) => {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const line = `[${ts}] ${s}`;
    if (logEl) logEl.textContent = line + "\n" + (logEl.textContent || "");
    console.log(line);
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
    try { return ethers.formatUnits(x, d); } catch { return "-"; }
  }
  function parse(x, d) {
    return ethers.parseUnits(x, d);
  }

  // ---- Load config ----
  let cfg;
  try {
    cfg = await loadGobogConfig();
  } catch (e) {
    log("Config error: " + (e?.message || String(e)));
    alert("Failed to load config.json. Make sure it exists and is valid JSON.");
    return;
  }

  // Explorer link
  const ex = $("explorerPresale");
  if (ex) ex.href = `${cfg.EXPLORER_BASE}/address/${cfg.PRESALE_ADDRESS}`;

  // ABI
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

  // ---- Phase schedule (UI) ----
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
      const shownUsdtPerGobg  = isFuture ? "X.XXXX" : p.usdt_per_gobg;

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

  function updateEstimate() {
    const amtStr = $("amt")?.value?.trim();
    if (!amtStr) { if ($("estOut")) $("estOut").textContent = "Estimated output: -"; return; }
    const x = Number(amtStr);
    if (!isFinite(x) || x <= 0) { if ($("estOut")) $("estOut").textContent = "Estimated output: -"; return; }

    const rate = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? getUiTokensPerUsdt() : 15;
    const out = x * rate;
    const tag = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? "UI phase rate" : "Base rate";
    if ($("estOut")) $("estOut").textContent = `Estimated output (${tag}): ${out.toLocaleString()} GOBG`;
  }

  // ---- Wallet / Contracts ----
  let provider, signer, userAddr;
  let usdt, presale;
  let wcProvider = null; // WalletConnect provider (v2)

  function setUiDisconnected() {
    if ($("netName")) $("netName").textContent = "-";
    if ($("wallet")) $("wallet").textContent = "-";
    if ($("usdtBal")) $("usdtBal").textContent = "-";
    if ($("claimable")) $("claimable").textContent = "-";
    if ($("ends")) $("ends").textContent = "-";
  }

  async function trySwitchOrAddChain(providerSource) {
    const targetHex = "0x" + Number(cfg.CHAIN_ID).toString(16);

    // params for wallet_addEthereumChain (generic)
    const addParams = cfg.ADD_CHAIN_PARAMS || {
      chainId: targetHex,
      chainName: cfg.CHAIN_NAME,
      rpcUrls: [cfg.RPC_URL],
      nativeCurrency: {
        name: "BNB",
        symbol: "BNB",
        decimals: 18
      },
      blockExplorerUrls: [cfg.EXPLORER_BASE]
    };

    try {
      await providerSource.request?.({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetHex }]
      });
      return true;
    } catch (e) {
      // 4902 = chain not added
      if (e?.code === 4902) {
        await providerSource.request?.({
          method: "wallet_addEthereumChain",
          params: [addParams]
        });
        return true;
      }
      // some wallets disallow programmatic switch; we just inform user
      log("Switch chain failed: " + (e?.message || String(e)));
      return false;
    }
  }

  async function ensureNetwork(providerSource) {
    if (!providerSource) throw new Error("Wallet provider not found.");

    const mm = new ethers.BrowserProvider(providerSource);
    const net = await mm.getNetwork();

    if ($("netName")) $("netName").textContent = `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${Number(net.chainId)}`;

    if (Number(net.chainId) !== Number(cfg.CHAIN_ID)) {
      log(`Network mismatch. Need chainId ${cfg.CHAIN_ID}. Trying to switch/add...`);
      await trySwitchOrAddChain(providerSource);

      const mm2 = new ethers.BrowserProvider(providerSource);
      const net2 = await mm2.getNetwork();
      if (Number(net2.chainId) !== Number(cfg.CHAIN_ID)) {
        throw new Error(`Wrong network. Please switch to ${cfg.CHAIN_NAME} (chainId ${cfg.CHAIN_ID}).`);
      }
      return mm2;
    }

    return mm;
  }

  async function connectWith(providerSource) {
    provider = await ensureNetwork(providerSource);

    // request accounts
    try { await provider.send("eth_requestAccounts", []); } catch (_) {}

    signer = await provider.getSigner();
    userAddr = await signer.getAddress();

    if ($("wallet")) $("wallet").textContent = userAddr;

    usdt = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, signer);
    presale = new ethers.Contract(cfg.PRESALE_ADDRESS, presaleAbi, signer);

    log("Connected.");
    await refresh();
    updateEstimate();
  }

  async function connectInjected() {
    const injected = window.ethereum;
    if (!injected) throw new Error("No injected wallet found (MetaMask extension not detected).");
    await connectWith(injected);
  }

  async function connectWalletConnectV2({ forceModal } = { forceModal: true }) {
    if (!cfg.WALLETCONNECT_PROJECT_ID) {
      throw new Error("Missing WALLETCONNECT_PROJECT_ID in config.json");
    }
    if (!window.WalletConnectEthereumProvider?.init) {
      throw new Error("WalletConnect provider not loaded. Check script tag in presale.html.");
    }

    // create provider once
    if (!wcProvider) {
      wcProvider = await window.WalletConnectEthereumProvider.init({
        projectId: cfg.WALLETCONNECT_PROJECT_ID,
        chains: [Number(cfg.CHAIN_ID)],
        optionalChains: [Number(cfg.CHAIN_ID)],
        rpcMap: { [Number(cfg.CHAIN_ID)]: cfg.RPC_URL },
        showQrModal: !!forceModal,
        metadata: {
          name: `${cfg.PROJECT_NAME} Presale`,
          description: "GOBOG presale dApp",
          url: cfg.SITE_URL || window.location.origin,
          icons: [cfg.SITE_ICON || (cfg.SITE_URL ? (cfg.SITE_URL + "/assets/logo.png") : "")]
        }
      });

      wcProvider.on?.("disconnect", () => {
        log("WalletConnect disconnected.");
        wcProvider = null;
        provider = null; signer = null; userAddr = null;
        setUiDisconnected();
      });
    }

    // connect triggers modal (mobile deep link / wallet list)
    await wcProvider.connect();

    await connectWith(wcProvider);
  }

  // Buttons: Connect tries injected first, fallback to WC v2
  async function onConnect() {
    try {
      if (window.ethereum) return await connectInjected();
      return await connectWalletConnectV2({ forceModal: true });
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      log("Connect error: " + msg);
      alert("Connect failed: " + msg);
    }
  }

  // Connect (QR) forces WalletConnect modal
  async function onConnectQR() {
    try {
      return await connectWalletConnectV2({ forceModal: true });
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      log("Connect(QR) error: " + msg);
      alert("Connect failed: " + msg);
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
      if ($("usdtBal")) $("usdtBal").textContent = fmt(bal, cfg.USDT_DECIMALS);
      if ($("claimable")) $("claimable").textContent = fmt(cl, cfg.TOKEN_DECIMALS);

      const endDate = new Date(Number(end) * 1000);
      if ($("ends")) $("ends").textContent = endDate.toLocaleString();
    } catch (e) {
      log("Refresh error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function approveUSDT() {
    const amtStr = $("amt")?.value?.trim();
    if (!amtStr) return alert("Enter USDT amount first.");
    const amt = parse(amtStr, cfg.USDT_DECIMALS);

    try {
      const allowance = await usdt.allowance(userAddr, cfg.PRESALE_ADDRESS);
      if (allowance >= amt) {
        log("Allowance sufficient. No need to approve again.");
        return;
      }
      const tx = await usdt.approve(cfg.PRESALE_ADDRESS, amt);
      log("Approve tx: " + tx.hash);
      await tx.wait();
      log("Approve confirmed.");
      await refresh();
    } catch (e) {
      log("Approve error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function buy() {
    const amtStr = $("amt")?.value?.trim();
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
    } catch (e) {
      log("Finalize error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  // ---- Wire events (IMPORTANT: IDs must exist) ----
  if ($("connectBtn")) $("connectBtn").addEventListener("click", onConnect);
  if ($("connectQrBtn")) $("connectQrBtn").addEventListener("click", onConnectQR);

  if ($("approveBtn")) $("approveBtn").addEventListener("click", approveUSDT);
  if ($("buyBtn")) $("buyBtn").addEventListener("click", buy);
  if ($("claimBtn")) $("claimBtn").addEventListener("click", claim);
  if ($("finalizeBtn")) $("finalizeBtn").addEventListener("click", finalize);

  if ($("amt")) $("amt").addEventListener("input", updateEstimate);

  setInterval(() => { if (signer) refresh(); }, 10000);

  // Start UI
  setUiDisconnected();
  updateEstimate();
})();
