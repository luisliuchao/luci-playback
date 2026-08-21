import "./style.css";
import {
  JUMP_MS,
  SCRUB_STEPS,
  clampTime,
  formatWallClock,
  indexAtOrBefore,
  progressForTime,
  timeAtProgress,
  timeForScrubValue,
} from "./timeline";
import {
  canPickDirectory,
  countEncrypted,
  decodeCapture,
  forgetSavedDirectory,
  forgetScreenshotKey,
  keyUnlocksCaptures,
  loadScreenshotKey,
  luciFolderError,
  pickDirectory,
  rememberDirectory,
  rememberScreenshotKey,
  restoreDirectory,
  unlockScreenshotKey,
  type FolderIndex,
  type LocalCapture,
  type PickedFolder,
} from "./browserFolder";
import { explainPickError } from "./pickError";

type Frame = {
  day: string;
  timeMs: number;
  label: string;
  captureId?: number;
  src?: string;
  local?: LocalCapture;
};

const PLAY = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>`;
const PREV = `<svg viewBox="0 0 24 24"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z"/></svg>`;
const NEXT = `<svg viewBox="0 0 24 24"><path d="M13 6v12l8.5-6L13 6zM3.5 18l8.5-6-8.5-6v12z"/></svg>`;
const FULL = `<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm12 0h-2v3h-3v2h5v-5zM7 7h3V5H5v5h2V7zm7-2v2h3v3h2V5h-5z"/></svg>`;
const MORE = `<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
const RESET = `<svg viewBox="0 0 24 24"><path d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 0 1-8.9 3.1L6.64 17.6A7 7 0 0 0 19 13c0-3.87-3.13-7-7-7z"/></svg>`;
const MAIL = `<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5L4 8V6l8 5 8-5v2z"/></svg>`;
const INFO = `<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`;
const KEYCHAIN_CMD =
  'security find-generic-password -s "luci-electron Safe Storage" -w | pbcopy';
const CONTACT_HREF = "mailto:luisliuchao@gmail.com?subject=Luci%20Playback";
const ABOUT_HREF = "/about.html";
const MAC_PATH = "~/.luciMicrosoft";
const OTHER_PATH = "~/.luci";

function pathRow(path: string): string {
  return `<div class="path-row"><code>${escapeAttr(path)}</code><button class="copy-path" type="button" data-path="${escapeAttr(path)}">Copy</button></div>`;
}

function folderPathsHtml(): string {
  return `
    <p>On a Mac press Cmd+Shift+G and paste:</p>
    ${pathRow(MAC_PATH)}
    <p>On Linux or Windows:</p>
    ${pathRow(OTHER_PATH)}
  `;
}

function chooseHintHtml(): string {
  return `<div class="empty-hint">
    <p>Choose your Luci folder on this computer.</p>
    ${folderPathsHtml()}
  </div>`;
}

function emptyMessageHtml(message: string): string {
  return `<div class="empty-hint">
    <p>${escapeAttr(message)}</p>
    ${folderPathsHtml()}
  </div>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app");
}

const state = {
  frames: [] as Frame[],
  days: [] as string[],
  day: "",
  index: 0,
  playheadMs: 0,
  playing: false,
  speed: 5,
  root: "",
  source: "none" as "none" | "folder",
  hideTimer: 0,
  clickTimer: 0,
  error: "",
  folder: null as FolderIndex | null,
  key: null as CryptoKey | null,
  needPassword: false,
  objectUrls: [] as string[],
};

app.innerHTML = `
  <header class="topbar">
    <div class="brand">Luci Playback</div>
    <button class="choose" id="choose" type="button">Choose folder</button>
    <input id="folderFiles" type="file" hidden />
    <div class="path-chip">
      <span class="folder-name" id="root"></span>
    </div>
    <select id="day" disabled></select>
    <div class="menu" id="menuWrap">
      <button class="menu-btn" id="menuBtn" type="button" aria-label="More options" aria-haspopup="true" aria-expanded="false">${MORE}</button>
      <div class="menu-list" id="menuList" hidden>
        <a href="${ABOUT_HREF}">${INFO}<span>About Luci Playback</span></a>
        <button type="button" id="resetSaved">${RESET}<span>Reset saved path and password</span></button>
        <a href="${CONTACT_HREF}">${MAIL}<span>Contact for support or feedback</span></a>
      </div>
    </div>
  </header>
  <div class="player is-paused" id="player">
    <img id="frame" alt="" hidden />
    <div class="empty" id="empty">${chooseHintHtml()}</div>
    <form class="unlock" id="unlock" hidden>
      <p>These frames are encrypted. Enter the Luci Safe Storage password.</p>
      <p class="hint">On a Mac, copy this command and run it in Terminal. That puts the password on your clipboard. Paste it below.</p>
      ${pathRow(KEYCHAIN_CMD)}
      <div class="unlock-row">
        <input id="safePass" type="password" autocomplete="off" placeholder="Safe Storage password" />
        <button type="submit">Unlock</button>
      </div>
      <p class="disclaimer">Your password never leaves this computer. This browser keeps the unlock so you can refresh.</p>
    </form>
    <div class="big-play" id="bigPlay">${PLAY}</div>
    <div class="shade"></div>
    <div class="controls" id="controls">
      <div class="scrub-wrap" id="scrubWrap">
        <input class="scrub" id="scrub" type="range" min="0" max="0" value="0" disabled aria-label="Seek" />
      </div>
      <div class="bar">
        <button class="icon" id="play" type="button" disabled aria-label="Play" data-tip="Play (k)">${PLAY}</button>
        <button class="icon" id="prev" type="button" disabled aria-label="Previous frame" data-tip="Previous frame (j)">${PREV}</button>
        <button class="icon" id="next" type="button" disabled aria-label="Next frame" data-tip="Next frame (l)">${NEXT}</button>
        <div class="time" id="time" data-tip="Current time / last frame">0:00:00 / 0:00:00</div>
        <div class="grow"></div>
        <select id="speed" aria-label="Playback speed" data-tip="Playback speed">
          <option value="1">1x</option>
          <option value="2">2x</option>
          <option value="5" selected>5x</option>
          <option value="10">10x</option>
          <option value="30">30x</option>
        </select>
        <button class="icon" id="full" type="button" aria-label="Fullscreen" data-tip="Fullscreen (f)">${FULL}</button>
      </div>
    </div>
  </div>
`;

const rootLabel = must("#root");
const folderInput = must<HTMLInputElement>("#folderFiles");
const chooseButton = must<HTMLButtonElement>("#choose");
const menuBtn = must<HTMLButtonElement>("#menuBtn");
const menuList = must("#menuList");
const resetSavedButton = must<HTMLButtonElement>("#resetSaved");
const daySelect = must<HTMLSelectElement>("#day");
const player = must("#player");
const frameImage = must<HTMLImageElement>("#frame");
const empty = must("#empty");
const unlockForm = must<HTMLFormElement>("#unlock");
const safePass = must<HTMLInputElement>("#safePass");
const bigPlay = must("#bigPlay");
const playButton = must<HTMLButtonElement>("#play");
const prevButton = must<HTMLButtonElement>("#prev");
const nextButton = must<HTMLButtonElement>("#next");
const fullButton = must("#full");
let playGeneration = 0;
const scrub = must<HTMLInputElement>("#scrub");
const scrubWrap = must("#scrubWrap");
const speedSelect = must<HTMLSelectElement>("#speed");
const timeLabel = must("#time");
const controls = must("#controls");

folderInput.webkitdirectory = true;
folderInput.multiple = true;
chooseButton.hidden = !canPickDirectory();

chooseButton.addEventListener("click", () => {
  closeMenu();
  void chooseFolder();
});
menuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu();
});
menuList.addEventListener("click", (event) => {
  event.stopPropagation();
  if (event.target instanceof Element && event.target.closest("a")) {
    closeMenu();
  }
});
resetSavedButton.addEventListener("click", () => {
  void resetSaved();
});
document.addEventListener("click", () => {
  closeMenu();
});
empty.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".copy-path") : null;
  if (!button) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void copyText(button.dataset.path ?? MAC_PATH, button);
});
unlockForm.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".copy-path") : null;
  if (!button) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void copyText(button.dataset.path ?? KEYCHAIN_CMD, button);
});
unlockForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void unlockFolder();
});
daySelect.addEventListener("change", () => {
  state.day = daySelect.value;
  state.index = 0;
  state.playheadMs = 0;
  state.playing = false;
  playGeneration += 1;
  void loadDay();
});
playButton.addEventListener("click", (event) => {
  event.stopPropagation();
  togglePlay();
});
prevButton.addEventListener("click", (event) => {
  event.stopPropagation();
  step(-1);
});
nextButton.addEventListener("click", (event) => {
  event.stopPropagation();
  step(1);
});
fullButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleFullscreen();
});
controls.addEventListener("click", (event) => {
  event.stopPropagation();
});
controls.addEventListener("dblclick", (event) => {
  event.preventDefault();
  event.stopPropagation();
});
player.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".controls, .unlock, .choose, .copy-path, .path-row, .path-chip, a")) {
    return;
  }
  window.clearTimeout(state.clickTimer);
  state.clickTimer = window.setTimeout(() => {
    togglePlay();
  }, 220);
});
player.addEventListener("dblclick", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  if (event.target.closest(".controls, .icon, button, select, input, .unlock, .copy-path, .path-row, a")) {
    event.preventDefault();
    return;
  }
  window.clearTimeout(state.clickTimer);
  toggleFullscreen();
});
player.addEventListener("mousemove", showControls);
scrub.addEventListener("input", () => {
  const timeMs = timeForScrubValue(dayFrames(), Number(scrub.value));
  if (timeMs !== null) {
    seekToTime(timeMs);
  }
});
scrubWrap.addEventListener("pointerenter", (event) => {
  updateScrubTip(event.clientX);
});
scrubWrap.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || scrub.disabled) {
    return;
  }
  event.preventDefault();
  scrubWrap.classList.add("is-seeking");
  scrubWrap.setPointerCapture(event.pointerId);
  updateScrubTip(event.clientX);
  seekFromClientX(event.clientX);
});
scrubWrap.addEventListener("pointermove", (event) => {
  updateScrubTip(event.clientX);
  if (scrubWrap.hasPointerCapture(event.pointerId)) {
    seekFromClientX(event.clientX);
  }
});
scrubWrap.addEventListener("pointerleave", () => {
  if (!scrubWrap.classList.contains("is-seeking")) {
    hideScrubTip();
  }
});
scrubWrap.addEventListener("lostpointercapture", () => {
  scrubWrap.classList.remove("is-seeking");
  if (!scrubWrap.matches(":hover")) {
    hideScrubTip();
  }
});
speedSelect.addEventListener("change", () => {
  state.speed = Number(speedSelect.value);
});
speedSelect.addEventListener("click", (event) => {
  event.stopPropagation();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
    return;
  }
  if (event.code === "Space" || event.key === "k") {
    event.preventDefault();
    togglePlay();
  } else if (event.code === "Home") {
    event.preventDefault();
    jumpTo(0);
  } else if (event.code === "End") {
    event.preventDefault();
    jumpTo(dayFrames().length - 1);
  } else if (event.code === "Comma" || (event.code === "ArrowLeft" && event.shiftKey)) {
    event.preventDefault();
    jumpBy(event.code === "Comma" ? -JUMP_MS.tenSeconds : -JUMP_MS.minute);
  } else if (event.code === "Period" || (event.code === "ArrowRight" && event.shiftKey)) {
    event.preventDefault();
    jumpBy(event.code === "Period" ? JUMP_MS.tenSeconds : JUMP_MS.minute);
  } else if (event.code === "ArrowLeft" || event.key === "j") {
    step(-1);
  } else if (event.code === "ArrowRight" || event.key === "l") {
    step(1);
  } else if (event.key === "f") {
    toggleFullscreen();
  }
});

void start();

function toggleMenu(): void {
  if (menuList.hidden) {
    openMenu();
    return;
  }
  closeMenu();
}

function openMenu(): void {
  menuList.hidden = false;
  menuBtn.setAttribute("aria-expanded", "true");
}

function closeMenu(): void {
  menuList.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
}

async function resetSaved(): Promise<void> {
  closeMenu();
  await forgetSavedDirectory();
  clearObjectUrls();
  state.folder = null;
  state.key = null;
  state.source = "none";
  state.root = "";
  state.days = [];
  state.day = "";
  state.frames = [];
  state.index = 0;
  state.playheadMs = 0;
  state.playing = false;
  playGeneration += 1;
  state.needPassword = false;
  state.error = "";
  rootLabel.textContent = "";
  safePass.value = "";
  render();
}

async function start(): Promise<void> {
  state.error = "";
  render();
  const saved = await restoreDirectory();
  if (saved) {
    await useFolder({ index: saved });
  }
}

async function chooseFolder(): Promise<void> {
  try {
    await useFolder(await pickDirectory(folderInput));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
    state.source = "none";
    state.error = explainPickError(error);
    render();
  }
}

async function useFolder(picked: PickedFolder): Promise<void> {
  const { index, handle } = picked;
  clearObjectUrls();
  state.key = null;
  state.root = index.name;
  rootLabel.textContent = index.name;
  state.index = 0;
  state.playheadMs = 0;
  state.playing = false;
  playGeneration += 1;
  const sample = index.captures.filter((capture) => capture.day === (index.days[index.days.length - 1] ?? ""));
  const encrypted = await countEncrypted(sample);
  const invalid = luciFolderError(index, encrypted);
  if (invalid) {
    await forgetSavedDirectory();
    state.folder = null;
    state.source = "none";
    state.days = [];
    state.day = "";
    state.frames = [];
    state.needPassword = false;
    state.error = invalid;
    render();
    return;
  }
  if (handle) {
    await rememberDirectory(handle);
  }
  state.folder = index;
  state.source = "folder";
  state.days = index.days;
  state.day = index.days[index.days.length - 1] ?? "";
  state.error = "";
  if (encrypted > 0 && index.dbkey) {
    const savedKey = await loadScreenshotKey(index.dbkey);
    if (savedKey && (await keyUnlocksCaptures(savedKey, sample))) {
      state.key = savedKey;
      state.needPassword = false;
      loadFolderFrames();
      return;
    }
    if (index.needPassword) {
      state.needPassword = true;
      state.frames = [];
      render();
      return;
    }
    try {
      state.key = await unlockScreenshotKey(index.dbkey);
      await rememberScreenshotKey(index.dbkey, state.key);
    } catch {
      state.needPassword = true;
      state.frames = [];
      render();
      return;
    }
  }
  state.needPassword = false;
  loadFolderFrames();
}

async function unlockFolder(): Promise<void> {
  if (!state.folder?.dbkey) {
    return;
  }
  try {
    state.key = await unlockScreenshotKey(state.folder.dbkey, safePass.value);
    await rememberScreenshotKey(state.folder.dbkey, state.key);
    safePass.value = "";
    state.needPassword = false;
    state.error = "";
    loadFolderFrames();
  } catch {
    state.error = "That password did not unlock the Luci key.";
    state.needPassword = true;
    render();
  }
}

function loadFolderFrames(): void {
  if (!state.folder) {
    return;
  }
  state.frames = state.folder.captures
    .filter((capture) => capture.day === state.day)
    .map((capture) => {
      return {
        day: capture.day,
        timeMs: capture.timeMs,
        label: capture.label,
        captureId: capture.captureId,
        local: capture,
      };
    });
  state.index = 0;
  state.playheadMs = state.frames[0]?.timeMs ?? 0;
  if (state.frames.length === 0) {
    state.error = "No Luci frames found in that folder.";
  }
  render();
}

function loadDay(): void {
  loadFolderFrames();
}

async function copyText(value: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  const previous = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

function must<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) {
    throw new Error(`Missing ${selector}`);
  }
  return node;
}

function dayFrames(): Frame[] {
  return state.frames.filter((frame) => frame.day === state.day);
}

function togglePlay(): void {
  if (dayFrames().length === 0) {
    return;
  }
  state.playing = !state.playing;
  if (state.playing) {
    void playLoop();
    scheduleHide();
  } else {
    playGeneration += 1;
    showControls();
  }
  renderControls();
}

function step(delta: number): void {
  const frames = dayFrames();
  if (frames.length === 0) {
    return;
  }
  seekTo(state.index + delta);
}

function jumpBy(deltaMs: number): void {
  const frames = dayFrames();
  if (frames.length === 0) {
    return;
  }
  seekToTime(state.playheadMs + deltaMs);
}

function jumpTo(index: number): void {
  seekTo(index);
}

function progressFromClientX(clientX: number): number {
  const rect = scrubWrap.getBoundingClientRect();
  if (rect.width <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

function updateScrubTip(clientX: number): void {
  const rect = scrubWrap.getBoundingClientRect();
  const x = rect.width <= 0 ? 0 : Math.min(rect.width, Math.max(0, clientX - rect.left));
  scrubWrap.style.setProperty("--tip-x", `${x}px`);
  const timeMs = timeAtProgress(dayFrames(), progressFromClientX(clientX));
  if (timeMs === null) {
    hideScrubTip();
    return;
  }
  scrubWrap.dataset.tip = formatWallClock(timeMs);
}

function hideScrubTip(): void {
  delete scrubWrap.dataset.tip;
}

function seekFromClientX(clientX: number): void {
  const timeMs = timeAtProgress(dayFrames(), progressFromClientX(clientX));
  if (timeMs !== null) {
    seekToTime(timeMs);
  }
}

function seekTo(index: number): void {
  const frames = dayFrames();
  if (frames.length === 0) {
    return;
  }
  const clamped = Math.min(frames.length - 1, Math.max(0, index));
  const frame = frames[clamped];
  if (!frame) {
    return;
  }
  seekToTime(frame.timeMs);
}

function seekToTime(timeMs: number): void {
  const frames = dayFrames();
  if (frames.length === 0) {
    return;
  }
  playGeneration += 1;
  state.playheadMs = clampTime(frames, timeMs);
  state.index = indexAtOrBefore(frames, state.playheadMs);
  state.playing = false;
  showControls();
  render();
}

async function playLoop(): Promise<void> {
  const generation = (playGeneration += 1);
  while (state.playing && generation === playGeneration) {
    const frames = dayFrames();
    const last = frames[frames.length - 1];
    if (!last || state.playheadMs >= last.timeMs) {
      state.playheadMs = last?.timeMs ?? state.playheadMs;
      state.index = Math.max(0, frames.length - 1);
      state.playing = false;
      showControls();
      renderControls();
      return;
    }
    const next = frames[state.index + 1];
    if (!next) {
      state.playheadMs = last.timeMs;
      state.index = frames.length - 1;
      state.playing = false;
      showControls();
      renderControls();
      return;
    }
    const wait = Math.max(40, (next.timeMs - state.playheadMs) / state.speed);
    await sleep(wait);
    if (!state.playing || generation !== playGeneration) {
      return;
    }
    state.index += 1;
    state.playheadMs = frames[state.index]?.timeMs ?? next.timeMs;
    renderFrame();
    renderControls();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function showControls(): void {
  player.classList.add("show-ui");
  window.clearTimeout(state.hideTimer);
  if (state.playing) {
    scheduleHide();
  }
}

function scheduleHide(): void {
  window.clearTimeout(state.hideTimer);
  state.hideTimer = window.setTimeout(() => {
    if (state.playing) {
      player.classList.remove("show-ui");
    }
  }, 2200);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  void player.requestFullscreen();
}

function renderControls(): void {
  const frames = dayFrames();
  const ready = frames.length > 0;
  const last = frames[frames.length - 1];
  playButton.disabled = !ready;
  prevButton.disabled = !ready || state.index === 0;
  nextButton.disabled = !ready || state.index >= frames.length - 1;
  scrub.disabled = !ready;
  scrub.max = String(SCRUB_STEPS);
  const progress = ready ? progressForTime(frames, state.playheadMs) : 0;
  scrub.value = String(Math.round(progress * SCRUB_STEPS));
  scrub.style.setProperty("--progress", `${progress * 100}%`);
  playButton.innerHTML = state.playing ? PAUSE : PLAY;
  playButton.ariaLabel = state.playing ? "Pause" : "Play";
  playButton.dataset.tip = state.playing ? "Pause (k)" : "Play (k)";
  bigPlay.innerHTML = state.playing ? PAUSE : PLAY;
  player.classList.toggle("is-paused", !state.playing);
  player.classList.toggle("is-playing", state.playing);
  if (last) {
    timeLabel.textContent = `${formatWallClock(state.playheadMs)} / ${formatWallClock(last.timeMs)}`;
  } else {
    timeLabel.textContent = "0:00:00 / 0:00:00";
  }
}

function render(): void {
  daySelect.innerHTML = state.days
    .map((day) => `<option value="${day}" ${day === state.day ? "selected" : ""}>${formatDay(day)}</option>`)
    .join("");
  daySelect.disabled = state.days.length === 0;
  unlockForm.hidden = !state.needPassword;
  renderFrame();
  renderControls();
}

function renderFrame(): void {
  const frames = dayFrames();
  const frame = frames[state.index];
  if (!frame) {
    frameImage.hidden = true;
    empty.hidden = state.needPassword;
    if (state.error) {
      empty.innerHTML = emptyMessageHtml(state.error);
    } else if (state.source !== "none") {
      empty.innerHTML = emptyMessageHtml("No Luci JPEG frames found in that folder.");
    } else {
      empty.innerHTML = chooseHintHtml();
    }
    player.classList.remove("has-frames");
    return;
  }
  empty.hidden = true;
  unlockForm.hidden = true;
  frameImage.hidden = false;
  player.classList.add("has-frames");
  frameImage.alt = `Luci frame ${frame.label}`;
  if (frame.src) {
    frameImage.src = frame.src;
  } else if (frame.local) {
    void ensureLocalSrc(frame);
  }
  prefetch(frames, state.index);
}

async function ensureLocalSrc(frame: Frame): Promise<void> {
  if (frame.src || !frame.local) {
    return;
  }
  try {
    const blob = await decodeCapture(await frame.local.read(), state.key);
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    frame.src = url;
    const current = dayFrames()[state.index];
    if (current === frame) {
      frameImage.src = url;
    }
  } catch {
    if (!state.error) {
      await forgetScreenshotKey();
      state.error = "Could not decrypt a frame. Unlock with the Luci Safe Storage password.";
      state.needPassword = Boolean(state.folder?.dbkey);
      render();
    }
  }
}

function clearObjectUrls(): void {
  for (const url of state.objectUrls) {
    URL.revokeObjectURL(url);
  }
  state.objectUrls = [];
}


function prefetch(frames: Frame[], index: number): void {
  for (const frame of frames.slice(index + 1, index + 6)) {
    if (frame.local && !frame.src) {
      void ensureLocalSrc(frame);
      continue;
    }
    if (!frame.src) {
      continue;
    }
    const probe = new Image();
    probe.src = frame.src;
  }
}

function formatDay(day: string): string {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}
