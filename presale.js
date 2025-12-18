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

  async function connectWithEIP1193(p, label) {
    eip1193 = p;
    provider = new ethers.BrowserProvider(eip1193);

    // request accounts
    try { await provider.send("eth_requestAccounts", []); } catch (_) {}

    signer = await provider.getSigner();
    userAddr = await signer.getAddress();
    $("wallet").textContent = userAddr;

    const net = await provider.getNetwork();
    $("netName").textContent = `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${Number(net.chainId)} • via: ${label}`;

    // contracts
    usdt = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, signer);
    presale = new ethers.Contract(cfg.PRESALE_ADDRESS, presaleAbi, signer);

    log("Connected: " + userAddr);
    await refresh();
  }

  // ✅ NEW: load WalletConnect provider via ESM (no UMD globals)
  async function loadWalletConnectProvider() {
    const mod = await import("https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.23.1/+esm");
    if (!mod?.EthereumProvider) throw new Error("WalletConnect module loaded but EthereumProvider missing.");
    return mod.EthereumProvider;
  }

  async function connectUnified() {
    // 1) Injected first (desktop extension or wallet browser)
    if (window.ethereum) {
      await connectWithEIP1193(window.ethereum, "Injected");
      return;
    }

    // 2) WalletConnect for mobile browser
    if (!cfg.WALLETCONNECT_PROJECT_ID) throw new Error("Missing WALLETCONNECT_PROJECT_ID in config.json");
    if (!cfg.RPC_URL) throw new Error("Missing RPC_URL in config.json");

    const EthereumProvider = await loadWalletConnectProvider();

    if (!wcProvider) {
      wcProvider = await EthereumProvider.init({
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

      wcProvider.on("disconnect", () => log("WalletConnect disconnected"));
    }

    await wcProvider.connect();
    await connectWithEIP1193(wcProvider, "WalletConnect");
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
      await tx.wait()
