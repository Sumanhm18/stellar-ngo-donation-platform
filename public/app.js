const state = {
  network: "PUBLIC",
  networkPassphrase: "",
  horizonUrl: "",
  ngos: [],
  freighter: null,
  walletConnected: false,
  connectedPublicKey: "",
  currentDonationId: "",
  unsignedXdr: "",
  pendingSigningContext: null,
};

const stellarPublicKeyPattern = /^G[A-Z2-7]{55}$/;

const els = {
  networkPill: document.getElementById("networkPill"),
  ngoSelect: document.getElementById("ngoSelect"),
  amountInput: document.getElementById("amountInput"),
  purposeInput: document.getElementById("purposeInput"),
  messageInput: document.getElementById("messageInput"),
  ngoTargetGroup: document.getElementById("ngoTargetGroup"),
  walletTargetGroup: document.getElementById("walletTargetGroup"),
  recipientWalletPublicKey: document.getElementById("recipientWalletPublicKey"),
  walletModeHint: document.getElementById("walletModeHint"),
  donationForm: document.getElementById("donationForm"),
  walletStatus: document.getElementById("walletStatus"),
  donorPublicKey: document.getElementById("donorPublicKey"),
  connectFreighterBtn: document.getElementById("connectFreighterBtn"),
  fundTestnetBtn: document.getElementById("fundTestnetBtn"),
  fundTestnetHint: document.getElementById("fundTestnetHint"),
  confirmPanel: document.getElementById("confirmPanel"),
  confirmNetwork: document.getElementById("confirmNetwork"),
  confirmRecipientWallet: document.getElementById("confirmRecipientWallet"),
  confirmOneTimeAddress: document.getElementById("confirmOneTimeAddress"),
  confirmAmount: document.getElementById("confirmAmount"),
  confirmAndSignBtn: document.getElementById("confirmAndSignBtn"),
  cancelConfirmBtn: document.getElementById("cancelConfirmBtn"),
  unsignedXdr: document.getElementById("unsignedXdr"),
  signedXdr: document.getElementById("signedXdr"),
  submitSignedBtn: document.getElementById("submitSignedBtn"),
  resultBox: document.getElementById("resultBox"),
  donationIdValue: document.getElementById("donationIdValue"),
  txHashValue: document.getElementById("txHashValue"),
  ledgerValue: document.getElementById("ledgerValue"),
  explorerLink: document.getElementById("explorerLink"),
};

function getWalletMode() {
  const selected = document.querySelector("input[name='walletMode']:checked");
  return selected?.value ?? "freighter";
}

function getTargetMode() {
  const selected = document.querySelector("input[name='targetMode']:checked");
  return selected?.value ?? "ngo";
}

function setResult(message, kind = "info") {
  const colors = {
    info: "#def4ec",
    success: "#93ffcf",
    error: "#ff9a9a",
  };

  els.resultBox.textContent = message;
  els.resultBox.style.color = colors[kind] ?? colors.info;
}

async function api(path, init) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const details = json.details ?? json.error ?? response.statusText;
    throw new Error(typeof details === "string" ? details : JSON.stringify(details));
  }

  return json;
}

function renderNgos() {
  els.ngoSelect.innerHTML = "";

  if (state.ngos.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No NGOs registered yet";
    option.disabled = true;
    option.selected = true;
    els.ngoSelect.appendChild(option);
    return;
  }

  for (const ngo of state.ngos) {
    const option = document.createElement("option");
    option.value = ngo.id;
    option.textContent = `${ngo.name} (${ngo.stellarPublicKey.slice(0, 7)}...)`;
    els.ngoSelect.appendChild(option);
  }
}

async function loadNetworkAndNgos() {
  const [networkData, ngosData] = await Promise.all([
    api("/api/stellar/network"),
    api("/api/ngos"),
  ]);

  state.network = networkData.network;
  state.networkPassphrase = networkData.networkPassphrase;
  state.horizonUrl = networkData.horizonUrl;
  state.ngos = ngosData.ngos;

  els.networkPill.textContent = `Network: ${networkData.network} | Horizon: ${networkData.horizonVersion}`;
  renderNgos();
  updateTestnetFundingUi();
}

function updateTestnetFundingUi() {
  const isTestnet = state.network === "TESTNET";
  els.fundTestnetBtn.classList.toggle("hidden", !isTestnet);
  els.fundTestnetHint.classList.toggle("hidden", isTestnet);
}

function clearPendingConfirmation() {
  state.pendingSigningContext = null;
  els.confirmPanel.classList.add("hidden");
  els.confirmNetwork.textContent = "-";
  els.confirmRecipientWallet.textContent = "-";
  els.confirmOneTimeAddress.textContent = "-";
  els.confirmAmount.textContent = "-";
}

function setPendingConfirmation(details) {
  state.pendingSigningContext = details;
  els.confirmPanel.classList.remove("hidden");
  els.confirmNetwork.textContent = details.network;
  els.confirmRecipientWallet.textContent = details.recipientWalletPublicKey;
  els.confirmOneTimeAddress.textContent = details.oneTimeAddress;
  els.confirmAmount.textContent = `${details.amount} XLM`;
}

async function ensureFreighterLoaded() {
  if (state.freighter) {
    return state.freighter;
  }

  const injectedApi = window.freighterApi;
  if (injectedApi && typeof injectedApi === "object") {
    state.freighter = injectedApi;
    return state.freighter;
  }

  throw new Error(
    "Freighter extension API not detected. Enable Freighter for this browser/profile and allow localhost access.",
  );
}

async function readFreighterPublicKey(freighter) {
  if (typeof freighter.getPublicKey === "function") {
    return freighter.getPublicKey();
  }

  if (typeof freighter.getAddress === "function") {
    return freighter.getAddress();
  }

  throw new Error("Freighter API missing getPublicKey/getAddress method");
}

function extractPublicKey(result) {
  if (typeof result === "string") {
    return result.trim();
  }

  const maybeKey = result?.publicKey ?? result?.address;
  return typeof maybeKey === "string" ? maybeKey.trim() : "";
}

function extractFreighterError(result) {
  const maybeError = result?.error ?? result?.apiError;
  if (!maybeError) {
    return "";
  }

  if (typeof maybeError === "string") {
    return maybeError;
  }

  if (typeof maybeError?.message === "string" && maybeError.message.trim()) {
    return maybeError.message.trim();
  }

  if (typeof maybeError?.name === "string" && maybeError.name.trim()) {
    return maybeError.name.trim();
  }

  try {
    return JSON.stringify(maybeError);
  } catch (_error) {
    return "Freighter returned an unknown error";
  }
}

async function requestFreighterAddress(freighter) {
  if (typeof freighter.requestAccess === "function") {
    const accessResult = await freighter.requestAccess();
    const accessError = extractFreighterError(accessResult);

    if (accessError) {
      throw new Error(accessError);
    }

    const accessKey = extractPublicKey(accessResult);
    if (accessKey) {
      return accessKey;
    }
  }

  const publicKeyResult = await readFreighterPublicKey(freighter);
  const readError = extractFreighterError(publicKeyResult);

  if (readError) {
    throw new Error(readError);
  }

  const publicKey = extractPublicKey(publicKeyResult);
  if (!publicKey) {
    throw new Error(
      "Freighter did not return a wallet address. Unlock Freighter and approve site access.",
    );
  }

  return publicKey;
}

async function signWithFreighter(freighter, xdr, options) {
  if (typeof freighter.signTransaction !== "function") {
    throw new Error("Freighter API missing signTransaction method");
  }

  return freighter.signTransaction(xdr, options);
}

function extractSignedXdr(result) {
  if (typeof result === "string") {
    return result;
  }

  const maybeSigned = result?.signedTxXdr ?? result?.signedXdr ?? result?.xdr;
  return typeof maybeSigned === "string" ? maybeSigned : "";
}

function normalizeUiError(error, fallbackMessage) {
  const message = error instanceof Error ? error.message : fallbackMessage;

  if (message.includes("does not exist on the selected Stellar network")) {
    return `The donor wallet is not active on ${state.network}. Use a funded ${state.network} account, or switch app network to match your wallet (PUBLIC vs TESTNET).`;
  }

  if (/declined|rejected/i.test(message)) {
    return "Freighter request was rejected. Open Freighter and approve the access/sign request.";
  }

  if (/not allowed|not authorized|permission/i.test(message)) {
    return "Freighter blocked this request. Allow localhost in Freighter settings and try again.";
  }

  return message;
}

function hasInjectedFreighter() {
  return typeof window.freighter !== "undefined";
}

function updateWalletAvailabilityHint() {
  if (hasInjectedFreighter() && !state.walletConnected) {
    els.walletStatus.textContent = "Freighter detected. Click Connect Freighter";
  }

  if (!hasInjectedFreighter() && !state.walletConnected) {
    els.walletStatus.textContent = "Freighter not detected. Manual mode is recommended.";
  }
}

function setWalletMode(mode) {
  const option = document.querySelector(`input[name='walletMode'][value='${mode}']`);
  if (!option) {
    return;
  }

  option.checked = true;
}

function setWalletInputsState() {
  const mode = getWalletMode();
  const manual = mode === "manual";

  els.connectFreighterBtn.disabled = manual;
  els.donorPublicKey.readOnly = !manual;

  if (!manual && state.connectedPublicKey) {
    els.donorPublicKey.value = state.connectedPublicKey;
  }
}

function setTargetInputsState() {
  const mode = getTargetMode();
  const isNgoMode = mode === "ngo";

  els.ngoTargetGroup.classList.toggle("hidden", !isNgoMode);
  els.walletTargetGroup.classList.toggle("hidden", isNgoMode);
  els.walletModeHint.classList.toggle("hidden", isNgoMode);

  els.ngoSelect.required = isNgoMode;
  els.ngoSelect.disabled = !isNgoMode;

  els.recipientWalletPublicKey.required = !isNgoMode;
  els.recipientWalletPublicKey.disabled = isNgoMode;

  els.purposeInput.disabled = !isNgoMode;
  els.messageInput.disabled = !isNgoMode;

  if (!isNgoMode) {
    els.purposeInput.value = "";
    els.messageInput.value = "";
  }
}

async function connectFreighter() {
  try {
    const freighter = await ensureFreighterLoaded();
    const publicKey = await requestFreighterAddress(freighter);

    if (!publicKey || !publicKey.startsWith("G")) {
      throw new Error("Freighter returned an invalid public key");
    }

    state.walletConnected = true;
    state.connectedPublicKey = publicKey;
    els.walletStatus.textContent = `Connected: ${publicKey}`;
    els.donorPublicKey.value = publicKey;
  } catch (error) {
    const message = normalizeUiError(error, "Freighter connection failed");
    setResult(message, "error");

    if (!hasInjectedFreighter()) {
      els.walletStatus.textContent = "Freighter extension signal not found in this browser profile.";
    }
  }
}

async function fundTestnetWallet() {
  if (state.network !== "TESTNET") {
    setResult("Wallet funding button works only on TESTNET.", "error");
    return;
  }

  const targetPublicKey = els.donorPublicKey.value.trim().toUpperCase();
  if (!stellarPublicKeyPattern.test(targetPublicKey)) {
    setResult("Enter a valid donor public key before funding.", "error");
    return;
  }

  try {
    setResult("Funding wallet from Friendbot...", "info");
    const funded = await api("/api/testnet/fund-wallet", {
      method: "POST",
      body: JSON.stringify({ publicKey: targetPublicKey }),
    });

    const hashSuffix = funded.hash ? ` Transaction: ${funded.hash}` : "";
    setResult(`Wallet funded on TESTNET.${hashSuffix}`, "success");
  } catch (error) {
    const message = normalizeUiError(error, "Friendbot funding failed");
    setResult(message, "error");
  }
}

async function confirmAndContinue() {
  const pending = state.pendingSigningContext;
  if (!pending) {
    setResult("Create a donation first before confirming.", "error");
    return;
  }

  if (getWalletMode() !== "freighter") {
    setResult(
      "Recipient confirmed. Sign the unsigned XDR in your wallet and paste signed XDR below.",
      "info",
    );
    return;
  }

  if (!state.walletConnected) {
    setResult("Connect Freighter first, or switch to Manual mode.", "error");
    return;
  }

  try {
    setResult("Signing transaction in Freighter...", "info");
    const freighter = await ensureFreighterLoaded();
    const signedResult = await signWithFreighter(freighter, pending.xdr, {
      networkPassphrase: pending.networkPassphrase,
      address: state.connectedPublicKey,
    });

    const signError = extractFreighterError(signedResult);
    if (signError) {
      throw new Error(signError);
    }

    const signedXdr = extractSignedXdr(signedResult);
    if (!signedXdr) {
      throw new Error("Freighter did not return a signed XDR");
    }

    await submitSignedXdr(pending.donationId, signedXdr);
    clearPendingConfirmation();
  } catch (error) {
    const message = normalizeUiError(error, "Signing failed");
    setResult(message, "error");
  }
}

function explorerUrl(txHash) {
  const path = state.network === "PUBLIC" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${path}/tx/${txHash}`;
}

async function submitSignedXdr(donationId, signedXdr) {
  const submit = await api(`/api/donations/${donationId}/submit`, {
    method: "POST",
    body: JSON.stringify({ signedXdr }),
  });

  els.donationIdValue.textContent = submit.donationId;
  els.txHashValue.textContent = submit.txHash;
  els.ledgerValue.textContent = String(submit.ledger);
  els.explorerLink.href = explorerUrl(submit.txHash);
  els.explorerLink.classList.remove("hidden");
  setResult(`Success: on-chain transaction confirmed in ledger ${submit.ledger}`, "success");
}

async function createAndBuildDonation(event) {
  event.preventDefault();

  const donorPublicKey = els.donorPublicKey.value.trim();
  if (!donorPublicKey) {
    setResult("Donor public key is required", "error");
    return;
  }

  const amountValue = Number(els.amountInput.value);
  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    setResult("Enter a valid donation amount", "error");
    return;
  }

  const amount = amountValue.toFixed(7);
  const targetMode = getTargetMode();

  const intentPayload = {
    amount,
    asset: { type: "native", code: "XLM" },
  };

  if (targetMode === "ngo") {
    if (!els.ngoSelect.value) {
      setResult("Select an NGO", "error");
      return;
    }

    intentPayload.ngoId = els.ngoSelect.value;
    intentPayload.donorMessage = els.messageInput.value.trim() || undefined;
    intentPayload.purpose = els.purposeInput.value.trim() || undefined;
  } else {
    const recipientWalletPublicKey = els.recipientWalletPublicKey.value.trim().toUpperCase();
    if (!stellarPublicKeyPattern.test(recipientWalletPublicKey)) {
      setResult("Recipient wallet public key must be a valid Stellar G address", "error");
      return;
    }

    intentPayload.recipientWalletPublicKey = recipientWalletPublicKey;
  }

  setResult("Creating donation intent...", "info");

  try {
    const intent = await api("/api/donations/intents", {
      method: "POST",
      body: JSON.stringify(intentPayload),
    });

    const build = await api(`/api/donations/${intent.donation.id}/build-transaction`, {
      method: "POST",
      body: JSON.stringify({ donorPublicKey }),
    });

    state.currentDonationId = intent.donation.id;
    state.unsignedXdr = build.xdr;
    els.unsignedXdr.value = build.xdr;
    els.signedXdr.value = "";
    els.donationIdValue.textContent = intent.donation.id;
    els.txHashValue.textContent = "-";
    els.ledgerValue.textContent = "-";
    els.explorerLink.classList.add("hidden");

    setPendingConfirmation({
      donationId: intent.donation.id,
      xdr: build.xdr,
      networkPassphrase: build.networkPassphrase,
      network: state.network,
      recipientWalletPublicKey: intent.donation.recipientWalletPublicKey,
      oneTimeAddress: intent.donation.oneTimeAddress,
      amount: intent.donation.amount,
    });

    setResult("Review recipient details, then click Confirm And Continue.", "info");
  } catch (error) {
    const message = normalizeUiError(error, "Donation flow failed");
    setResult(message, "error");
  }
}

async function submitManualSignedXdr() {
  const signedXdr = els.signedXdr.value.trim();

  if (!state.currentDonationId) {
    setResult("Create a donation intent first.", "error");
    return;
  }

  if (!signedXdr) {
    setResult("Paste signed XDR first.", "error");
    return;
  }

  try {
    setResult("Submitting signed transaction to Stellar...", "info");
    await submitSignedXdr(state.currentDonationId, signedXdr);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Submission failed";
    setResult(message, "error");
  }
}

async function init() {
  try {
    await loadNetworkAndNgos();
    setResult("Ready. Choose NGO and donate.", "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Initialization failed";
    setResult(message, "error");
  }

  setWalletInputsState();
  setTargetInputsState();
  clearPendingConfirmation();
  updateWalletAvailabilityHint();

  document.querySelectorAll("input[name='walletMode']").forEach((input) => {
    input.addEventListener("change", () => {
      setWalletInputsState();
      if (getWalletMode() === "manual") {
        els.walletStatus.textContent = "Manual mode enabled";
      } else if (state.walletConnected) {
        els.walletStatus.textContent = `Connected: ${state.connectedPublicKey}`;
      } else {
        els.walletStatus.textContent = "Not connected";
      }
    });
  });

  document.querySelectorAll("input[name='targetMode']").forEach((input) => {
    input.addEventListener("change", () => {
      setTargetInputsState();
      clearPendingConfirmation();
      if (getTargetMode() === "wallet") {
        setResult("Direct wallet mode enabled. Enter recipient wallet public key.", "info");
      }
    });
  });

  els.connectFreighterBtn.addEventListener("click", connectFreighter);
  els.fundTestnetBtn.addEventListener("click", fundTestnetWallet);
  els.donationForm.addEventListener("submit", createAndBuildDonation);
  els.confirmAndSignBtn.addEventListener("click", confirmAndContinue);
  els.cancelConfirmBtn.addEventListener("click", () => {
    clearPendingConfirmation();
    setResult("Recipient confirmation canceled.", "info");
  });
  els.submitSignedBtn.addEventListener("click", submitManualSignedXdr);
}

init();
