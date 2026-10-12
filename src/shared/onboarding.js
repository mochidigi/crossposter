import { setHtml } from "./dom.js";
import { icon } from "./icons.js";

const slides = [
  {
    eyebrow: "One place, less repetition",
    title: "Post everywhere, faster.",
    copy: "Crossposter saves you time posting to multiple social media accounts – right from your browser.",
    art: `<svg viewBox="0 0 520 260" role="img" aria-label="One Crossposter post being sent to UpScrolled, X, LinkedIn, Bluesky, Instagram, and Facebook">
      <defs><marker id="onboardingArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="art-arrowhead" d="M0 0 10 5 0 10Z"/></marker></defs>
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
  // The editors mark what they keep in the signal color (--signal); so do
  // these: the crop frame and the trimmed clip.
  {
    eyebrow: "Edit your images",
    title: "Crop it. Mark it up.",
    copy: "Select Edit on any image to crop it square, portrait, landscape, or for stories, rotate it, and add arrows, boxes, highlights, or text.",
    art: `<svg viewBox="0 0 520 260" role="img" aria-label="An image in Crossposter’s image editor, cropped square, with a box and an arrow drawn on it">
      <defs><marker id="onboardingMarkupArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="art-arrowhead" d="M0 0 10 5 0 10Z"/></marker></defs>
      <rect class="art-paper" x="58" y="22" width="404" height="216" rx="3"/><path class="art-line" d="M58 58h404"/>
      <rect class="art-field" x="78" y="31" width="18" height="18" rx="2"/><rect class="art-menu-active" x="102" y="31" width="18" height="18" rx="2"/><path class="art-glyph" d="M107 34v10h10M104 37h10v10"/><rect class="art-field" x="126" y="31" width="18" height="18" rx="2"/><rect class="art-field" x="150" y="31" width="18" height="18" rx="2"/><rect class="art-field" x="174" y="31" width="18" height="18" rx="2"/><rect class="art-field" x="198" y="31" width="18" height="18" rx="2"/>
      <rect class="art-media" x="78" y="74" width="236" height="146" rx="2"/><path class="art-line" d="M78 196l52-50 34 30 46-48 104 68"/><circle class="art-line" cx="232" cy="106" r="10"/>
      <path class="art-dim" fill-rule="evenodd" d="M78 74h236v146H78zM130 82h130v130H130z"/>
      <rect class="art-signal" x="130" y="82" width="130" height="130"/><path class="art-signal-corner" d="M130 96V82h14M246 82h14v14M260 198v14h-14M144 212h-14v-14"/>
      <rect class="art-line" x="216" y="91" width="32" height="30"/><path class="art-arrow" marker-end="url(#onboardingMarkupArrow)" d="M152 96l56 9"/>
      <rect class="art-menu-active" x="336" y="74" width="106" height="30" rx="2"/><rect class="art-glyph" x="348" y="83" width="12" height="12"/><path class="art-glyph" d="M372 89h44"/>
      <rect class="art-field" x="336" y="112" width="106" height="30" rx="2"/><rect class="art-line" x="348" y="119" width="12" height="15"/><path class="art-menu-line" d="M372 127h38"/>
      <rect class="art-field" x="336" y="150" width="106" height="30" rx="2"/><rect class="art-line" x="345" y="160" width="18" height="10"/><path class="art-menu-line" d="M372 165h46"/>
      <rect class="art-field" x="336" y="188" width="106" height="30" rx="2"/><rect class="art-line" x="349" y="195" width="10" height="16"/><path class="art-menu-line" d="M372 203h34"/>
    </svg>`
  },
  {
    eyebrow: "Trim your videos",
    title: "Keep just the good part.",
    copy: "Select Edit on a video to trim it to the moment that matters, and crop it square, portrait, landscape, or vertical for stories and reels.",
    art: `<svg viewBox="0 0 520 260" role="img" aria-label="A video in Crossposter’s video editor, trimmed to a shorter clip and cropped vertical">
      <rect class="art-paper" x="58" y="22" width="404" height="216" rx="3"/>
      <rect class="art-media" x="78" y="38" width="364" height="124" rx="2"/><path class="art-line" d="M78 140l70-40 50 28 64-50 70 46 110-36"/>
      <path class="art-dim" fill-rule="evenodd" d="M78 38h364v124H78zM225 38h70v124h-70z"/><rect class="art-signal" x="225" y="38" width="70" height="124"/>
      <circle class="art-fill" cx="260" cy="100" r="16"/><path class="art-glyph" d="m255 91 13 9-13 9z"/>
      <rect class="art-media" x="78" y="180" width="364" height="40" rx="2"/><path class="art-line" d="M130 180v40M182 180v40M234 180v40M286 180v40M338 180v40M390 180v40"/>
      <path class="art-dim" fill-rule="evenodd" d="M78 180h364v40H78zM164 180h154v40H164z"/><path class="art-signal" d="M164 181.5h154M164 218.5h154"/>
      <rect class="art-signal-fill" x="157" y="175" width="10" height="50" rx="2"/><rect class="art-signal-fill" x="315" y="175" width="10" height="50" rx="2"/><path class="art-tick" d="M162 192v16M320 192v16"/>
      <path class="art-playhead" d="M244 174v52"/><path class="art-fill" d="m238 170h12l-6 7z"/>
    </svg>`
  }
];

export function setupOnboarding(trigger) {
  if (!trigger) return;
  const dialog = document.createElement("dialog");
  dialog.className = "onboarding-dialog";
  dialog.setAttribute("aria-labelledby", "onboardingTitle");
  setHtml(dialog, `<section class="onboarding-card">
    <header class="onboarding-head"><span class="onboarding-brand"><img src="icons/icon-32.png" alt="">Getting started</span><button class="onboarding-close" type="button" aria-label="Close getting started">${icon("close")}</button></header>
    <div class="onboarding-art"></div><div class="onboarding-copy"><div class="eyebrow"></div><h2 id="onboardingTitle"></h2><p></p></div>
    <footer class="onboarding-foot"><div class="onboarding-dots" aria-label="Getting started progress"></div><div class="onboarding-actions"><button class="secondary onboarding-back" type="button">Back</button><button class="primary onboarding-next" type="button">Next</button></div></footer>
  </section>`);
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
