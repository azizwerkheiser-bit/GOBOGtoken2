(() => {
  const $ = (id) => document.getElementById(id);

  const log = (msg) => {
    const el = $("log");
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    if (el) el.textContent = `[${ts}] ${msg}\n` + el.textContent;
    console.log("[GOBOG]", msg);
  };

  const setText = (id, txt) => {
    const el = $(id);
    if (el) el.textContent = txt;
  };

  const setHref = (id, href) => {
    const el = $(id);
    if (el) el.href = href || "#";
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

  async function loadConfig() {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`config.json HTTP ${res.status}`);
    const cfg = await res.json();
    return cfg;
  }

  // ---------- Phase timeline ----------
  function buildTimeline(cfg) {
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

  function getActivePhase(cfg, now) {
    const { start, timeline } = buildTimeline(cfg);
    if (!start || timeline.length === 0) return { idx: -1, phase: null, phaseEnd: start || 0, timeline };
    const totalEnd = timeline[timeline.length - 1].end;

    if (now < start) return { idx: -1, phase: null, phaseEnd: start, timeline };

    const idx = timeline.findIndex((seg) => now >= seg.start && now < seg.end);
    if (idx === -1 && now >= totalEnd) return { idx: timeline.length, phase: null, phaseEnd: totalEnd, timeline };

    return { idx, phase: timeline[idx], phaseEnd: timeline[idx].end, timeline };
  }

  function renderPhases(cfg) {
    const listEl = $("phaseList");
    const activeEl = $("phaseActive");
    const cdEl = $("phaseCountdown");
    if (!listEl || !activeEl || !cdEl) return;

    const now = Math.floor(Date.now() / 1000);
    const info = getActivePhase(cfg, now);

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

    listEl.innerHTML = info.timeline
      .map((p, i) => {
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
      })
      .join("");
  }

  function getUiTokensPerUsdt(cfg) {
    const now = Math.floor(Date.now() / 1000);
    const info = getActivePhase(cfg, now);
    if (info.idx >= 0 && info.idx < info.timeline.length) {
      const v = Number(info.phase?.gobg_per_1_usdt);
      if (isFinite(v) && v > 0) return v;
    }
    return 15;
  }

  // ---------- WalletConnect modal (custom) ----------
  let wcOverlayEl = null;

  function ensureWcOverlay() {
    if (wcOverlayEl) return wcOverlayEl;

    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,0.72);
      display: none; align-items: center; justify-content: center;
      padding: 18px;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      width: min(520px, 100%);
      background: rgba(12,10,6,0.96);
      border: 1px solid rgba(245,197,66,0.35);
      border-radius: 18px;
      padding: 16px;
      color: #fff;
      box-shadow: 0 20px 80px rgba(0,0,0,0.6);
    `;

    card.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div style="font-weight:700; letter-spacing:0.3px;">Connect Wallet (WalletConnect)</div>
        <button id="wcCloseBtn" style="
          border: 1px solid rgba(245,197,66,0.35);
          background: transparent; color: #fff;
          padding: 8px 10px; border-radius: 12px; cursor:pointer;
        ">Close</button>
      </div>

      <div style="margin-top:12px; font-size:13px; opacity:0.85;">
        Scan the QR with your wallet, or tap a wallet button (mobile).
      </div>

      <div style="margin-top:14px; display:flex; gap:14px; flex-wrap:wrap; align-items:flex-start;">
        <div style="background:#fff; padding:10px; border-radius:14px;">
          <canvas id="wcQrCanvas" width="240" height="240"></canvas>
        </div>

        <div style="flex:1; min-width:200px;">
          <div style="display:flex; flex-direction:column; gap:10px;">
            <a id="wcTrustLink" href="#" style="
              display:block; text-align:center;
              background: rgba(245,197,66,0.14);
              border: 1px solid rgba(245,197,66,0.35);
              color:#fff; padding:10px 12px; border-radius:14px; text-decoration:none;
            ">Open Trust Wallet</a>

            <a id="wcMetaLink" href="#" style="
              display:block; text-align:center;
              background: rgba(245,197,66,0.14);
              border: 1px solid rgba(245,197,66,0.35);
              color:#fff; padding:10px 12px; border-radius:14px; text-decoration:none;
            ">Open MetaMask</a>

            <button id="wcCopyBtn" style="
              border: 1px solid rgba(245,197,66,0.35);
              background: transparent; color: #fff;
              padding: 10px 12px; border-radius: 14px; cursor:pointer;
            ">Copy WalletConnect URI</button>

            <div id="wcHint" style="font-size:12px; opacity:0.75; line-height:1.35;">
              If you're on Android and nothing happens, open this dApp inside your wallet’s built-in browser.
            </div>
          </div>
        </div>
      </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    overlay.querySelector("#wcCloseBtn").addEventListener("click", () => closeWcOverlay());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeWcOverlay();
    });

    wcOverlayEl = overlay;
    return overlay;
  }

  function openWcOverlay(uri) {
    const overlay = ensureWcOverlay();
    overlay.style.display = "flex";

    // QR
    const canvas = overlay.querySelector("#wcQrCanvas");
    if (window.QRCode && canvas) {
      window.QRCode.toCanvas(canvas, uri, { width: 240 }, (err) => {
        if (err) log("QR error: " + err.message);
      });
    } else {
      log("QRCode lib not loaded.");
    }

    // Deep links
    const trust = overlay.querySelector("#wcTrustLink");
    const meta = overlay.querySelector("#wcMetaLink");
    const enc = encodeURIComponent(uri);

    // These two are the most common “works in Chrome → opens wallet app” links:
    if (trust) trust.href = `https://link.trustwallet.com/wc?uri=${enc}`;
    if (meta) meta.href = `https://metamask.app.link/wc?uri=${enc}`;

    // Copy
    const copyBtn = overlay.querySelector("#wcCopyBtn");
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(uri);
          copyBtn.textContent = "Copied!";
          setTimeout(() => (copyBtn.textContent = "Copy WalletConnect URI"), 1200);
        } catch (e) {
          alert("Copy failed. Long-press to copy:\n\n" + uri);
        }
      };
    }
  }

  function closeWcOverlay() {
    if (wcOverlayEl) wcOverlayEl.style.display = "none";
  }

  // ---------- Ethers / Contracts ----------
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

  const fmt = (x, d) => {
    try { return ethers.formatUnits(x, d); } catch { return "-"; }
  };

  const parse = (x, d) => ethers.parseUnits(x, d);

  let cfg;
  let provider, signer, userAddr;
  let usdt, presale;
  let wcProvider = null;

  async function ensureNetworkInfo() {
    if (!provider) return;
    const net = await provider.getNetwork();
    setText("netName", `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${Number(net.chainId)}`);

    if (Number(net.chainId) !== Number(cfg.CHAIN_ID)) {
      log(`Network mismatch. Expected ${cfg.CHAIN_ID}, got ${Number(net.chainId)}.`);
    }
  }

  async function connectWith(eip1193) {
    provider = new ethers.BrowserProvider(eip1193);

    // request accounts (some providers need it)
    try { await provider.send("eth_requestAccounts", []); } catch (_) {}

    signer = await provider.getSigner();
    userAddr = await signer.getAddress();
    setText("wallet", userAddr);

    await ensureNetworkInfo();

    usdt = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, signer);
    presale = new ethers.Contract(cfg.PRESALE_ADDRESS, presaleAbi, signer);

    log("Connected: " + userAddr);
    await refresh();
  }

  async function connectInjected() {
    if (!window.ethereum) {
      throw new Error("No injected wallet found. Use WalletConnect (QR) or open this site inside your wallet browser.");
    }
    await connectWith(window.ethereum);
  }

  async function connectWalletConnect(showOverlay) {
    const WC = window.WalletConnectProvider && (window.WalletConnectProvider.default || window.WalletConnectProvider);
    if (!WC) throw new Error("WalletConnect library not loaded (walletconnect-web3-provider).");
    if (!cfg.RPC_URL) throw new Error("RPC_URL missing in config.json (needed for WalletConnect).");

    wcProvider = new WC({
      rpc: { [Number(cfg.CHAIN_ID)]: cfg.RPC_URL },
      chainId: Number(cfg.CHAIN_ID),
      qrcode: false
    });

    wcProvider.on("display_uri", (uri) => {
      log("WalletConnect URI received.");
      if (showOverlay) openWcOverlay(uri);
    });

    await wcProvider.enable(); // triggers display_uri
    closeWcOverlay();
    await connectWith(wcProvider);
  }

  async function refresh() {
    if (!signer || !usdt || !presale) return;

    try {
      const [bal, cl, end] = await Promise.all([
        usdt.balanceOf(userAddr),
        presale.claimable(userAddr),
        presale.endTime()
      ]);

      setText("usdtBal", fmt(bal, cfg.USDT_DECIMALS));
      setText("claimable", fmt(cl, cfg.TOKEN_DECIMALS));

      const endDate = new Date(Number(end) * 1000);
      setText("ends", endDate.toLocaleString());

      await ensureNetworkInfo();
    } catch (e) {
      log("Refresh error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  function updateEstimate() {
    const amtEl = $("amt");
    const outEl = $("estOut");
    if (!amtEl || !outEl) return;

    const amtStr = amtEl.value.trim();
    if (!amtStr) { outEl.textContent = "Estimated output: -"; return; }

    const x = Number(amtStr);
    if (!isFinite(x) || x <= 0) { outEl.textContent = "Estimated output: -"; return; }

    const rate = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? getUiTokensPerUsdt(cfg) : 15;
    const out = x * rate;
    const tag = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? "UI phase rate" : "Base rate";
    outEl.textContent = `Estimated output (${tag}): ${out.toLocaleString()} GOBG`;
  }

  async function approveUSDT() {
    const amtStr = $("amt")?.value?.trim?.() || "";
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
    const amtStr = $("amt")?.value?.trim?.() || "";
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

  async function init() {
    try {
      cfg = await loadConfig();
    } catch (e) {
      log("Config error: " + (e?.message || String(e)));
      alert("Failed to load config.json. Make sure it exists and is valid JSON.\n\n" + (e?.message || String(e)));
      return;
    }

    // explorer link
    setHref("explorerPresale", cfg.EXPLORER_BASE ? `${cfg.EXPLORER_BASE}/address/${cfg.PRESALE_ADDRESS}` : "#");

    // phases UI
    renderPhases(cfg);
    setInterval(() => renderPhases(cfg), 1000);

    // buttons
    $("approveBtn")?.addEventListener("click", approveUSDT);
    $("buyBtn")?.addEventListener("click", buy);
    $("claimBtn")?.addEventListener("click", claim);
    $("finalizeBtn")?.addEventListener("click", finalize);
    $("amt")?.addEventListener("input", updateEstimate);

    // connect buttons
    $("connectBtn")?.addEventListener("click", async () => {
      try {
        if (window.ethereum) {
          await connectInjected();
        } else {
          await connectWalletConnect(true);
        }
      } catch (e) {
        const msg = e?.shortMessage || e?.message || String(e);
        log("Connect error: " + msg);
        alert("Connect failed: " + msg);
      }
    });

    $("connectQrBtn")?.addEventListener("click", async () => {
      try {
        await connectWalletConnect(true);
      } catch (e) {
        const msg = e?.shortMessage || e?.message || String(e);
        log("Connect (QR) error: " + msg);
        alert("Connect (QR) failed: " + msg);
      }
    });

    setInterval(() => { if (signer) refresh(); }, 10000);

    log("App loaded.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
