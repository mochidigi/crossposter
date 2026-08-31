import { setHtml } from "./dom.js";

const slides = [
  {
    eyebrow: "One place, less repetition",
    title: "Post everywhere, faster.",
    copy: "Crossposter saves you time posting to multiple social media accounts – right from your browser.",
    art: `<svg viewBox="0 0 520 260" role="img" aria-label="One Crossposter post being sent to UpScrolled, X, LinkedIn, Bluesky, Instagram, and Facebook">
      <defs><marker id="onboardingArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10Z" fill="#111"/></marker></defs>
      <rect class="art-paper" x="140" y="38" width="240" height="184" rx="3"/><path class="art-line" d="M140 74h240"/><circle class="art-fill" cx="163" cy="56" r="6"/><path class="art-line" d="M178 56h52M169 103h182M169 122h148M169 141h169"/><rect class="art-media" x="169" y="162" width="94" height="34" rx="2"/><path class="art-line" d="M278 170h67M278 182h51M278 194h59"/>
      <path class="art-arrow" marker-end="url(#onboardingArrow)" d="M137 92 91 69"/><path class="art-arrow" marker-end="url(#onboardingArrow)" d="M383 92l46-23"/><path class="art-arrow" marker-end="url(#onboardingArrow)" d="M137 168l-46 23"/><path class="art-arrow" marker-end="url(#onboardingArrow)" d="M383 168l46 23"/>
      <path class="art-arrow" marker-end="url(#onboardingArrow)" d="M137 130H96"/><path class="art-arrow" marker-end="url(#onboardingArrow)" d="M383 130h41"/>
      <circle class="art-network-circle" cx="64" cy="56" r="28"/><image href="icons/networks/upscrolled.svg" x="51" y="39" width="26" height="34" preserveAspectRatio="xMidYMid meet"/>
      <circle class="art-network-circle" cx="456" cy="56" r="28"/><image href="icons/networks/x.svg" x="443" y="43" width="26" height="26"/>
      <circle class="art-network-circle" cx="64" cy="130" r="28"/><image href="icons/networks/instagram.svg" x="51" y="117" width="26" height="26"/>
      <circle class="art-network-circle" cx="456" cy="130" r="28"/><image href="icons/networks/facebook.svg" x="443" y="117" width="26" height="26"/>
      <circle class="art-network-circle" cx="64" cy="204" r="28"/><image href="icons/networks/linkedin.svg" x="51" y="191" width="26" height="26"/>
      <circle class="art-network-circle" cx="456" cy="204" r="28"/><image href="icons/networks/bluesky.svg" x="443" y="191" width="26" height="26"/>
    </svg>`
  },
  {
    eyebrow: "Right-click to crosspost",
    title: "See it. Share it onward.",
    copy: "Share posts, images, and videos from one platform to another with the right-click Crosspost menu.",
    art: `<svg viewBox="0 0 520 260" role="img" aria-label="A browser post with the Crosspost context menu open">
      <rect class="art-paper" x="60" y="28" width="286" height="204" rx="3"/><path class="art-line" d="M60 65h286M84 47h90"/><circle class="art-fill" cx="91" cy="91" r="13"/><path class="art-line" d="M114 85h92M114 98h60"/><rect class="art-media" x="84" y="119" width="238" height="88" rx="2"/><path class="art-glyph" d="m184 143 35 20-35 20z"/>
      <rect class="art-menu" x="281" y="87" width="178" height="112" rx="3"/><path class="art-menu-line" d="M302 114h88M302 139h65"/><rect class="art-menu-active" x="289" y="153" width="162" height="36" rx="2"/><path class="art-glyph" d="M306 171h16m-6-6 6 6-6 6"/><text class="art-text" x="333" y="176">Crosspost</text><path class="art-cursor" d="m259 147 12 43 10-13 16 13 8-9-16-13 13-9z"/>
    </svg>`
  },
  {
    eyebrow: "A helpful nudge",
    title: "Crossposter detects new posts",
    copy: "When you post directly, Crossposter adds a reminder badge so you can share elsewhere easily.",
    art: `<svg viewBox="0 0 520 260" role="img" aria-label="A LinkedIn post and the Crossposter toolbar button showing a reminder badge">
      <rect class="art-browser" x="44" y="30" width="432" height="200" rx="4"/><path class="art-browser-bar" d="M44 76h432"/>
      <circle class="art-window-dot" cx="67" cy="53" r="5"/><circle class="art-window-dot" cx="84" cy="53" r="5"/><circle class="art-window-dot" cx="101" cy="53" r="5"/>
      <rect class="art-address" x="125" y="42" width="236" height="23" rx="11"/><path class="art-line" d="M145 53h92"/>
      <rect class="art-toolbar-button" x="398" y="38" width="32" height="32" rx="5"/><image href="icons/icon-32.png" x="400" y="40" width="28" height="28"/>
      <circle class="art-reminder-badge" cx="432" cy="38" r="12"/><text class="art-badge-text" x="432" y="42">1</text>
      <rect class="art-post" x="136" y="94" width="248" height="110" rx="3"/><circle class="art-fill" cx="160" cy="117" r="11"/><path class="art-line" d="M180 111h76M180 124h48M155 150h205M155 167h171"/><rect class="art-dark" x="155" y="181" width="77" height="8" rx="1"/>
      <path class="art-reminder-line" d="M388 54c-34 5-46 25-45 48"/><path class="art-reminder-tip" d="m337 93 6 10 7-10"/>
    </svg>`
  }
];

export function setupOnboarding(trigger) {
  if (!trigger) return;
  const dialog = document.createElement("dialog");
  dialog.className = "onboarding-dialog";
  dialog.setAttribute("aria-labelledby", "onboardingTitle");
  dialog.innerHTML = `<section class="onboarding-card">
    <header class="onboarding-head"><span class="onboarding-brand"><img src="icons/icon-32.png" alt="">Getting started</span><button class="onboarding-close" type="button" aria-label="Close getting started">×</button></header>
    <div class="onboarding-art"></div><div class="onboarding-copy"><div class="eyebrow"></div><h2 id="onboardingTitle"></h2><p></p></div>
    <footer class="onboarding-foot"><div class="onboarding-dots" aria-label="Getting started progress"></div><div class="onboarding-actions"><button class="secondary onboarding-back" type="button">Back</button><button class="primary onboarding-next" type="button">Next</button></div></footer>
  </section>`;
  document.body.append(dialog);
  let index = 0;
  const render = () => {
    const slide = slides[index];
    setHtml(dialog.querySelector(".onboarding-art"), slide.art);
    dialog.querySelector(".onboarding-copy .eyebrow").textContent = slide.eyebrow;
    dialog.querySelector("h2").textContent = slide.title;
    dialog.querySelector(".onboarding-copy p").textContent = slide.copy;
    dialog.querySelector(".onboarding-back").hidden = index === 0;
    dialog.querySelector(".onboarding-next").textContent = index === slides.length - 1 ? "Start crossposting" : "Next";
    setHtml(dialog.querySelector(".onboarding-dots"), slides.map((_, dot) => `<button type="button" class="${dot === index ? "active" : ""}" data-slide="${dot}" aria-label="Show step ${dot + 1}" ${dot === index ? 'aria-current="step"' : ""}></button>`).join(""));
    dialog.querySelectorAll("[data-slide]").forEach(button => button.onclick = () => { index = Number(button.dataset.slide); render(); });
  };
  const close = () => dialog.close();
  trigger.onclick = () => { index = 0; render(); dialog.showModal(); };
  dialog.querySelector(".onboarding-close").onclick = close;
  dialog.querySelector(".onboarding-back").onclick = () => { index = Math.max(0, index - 1); render(); };
  dialog.querySelector(".onboarding-next").onclick = () => { if (index === slides.length - 1) close(); else { index += 1; render(); } };
  dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
  dialog.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft" && index > 0) { index -= 1; render(); }
    if (event.key === "ArrowRight" && index < slides.length - 1) { index += 1; render(); }
  });
  render();
}
