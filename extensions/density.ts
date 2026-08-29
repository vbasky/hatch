const STYLE_ID = "extension-density";

const CSS = `:root {
  --fs-xxs: 0.75rem;
  --fs-xs: 0.875rem;
  --fs-sm: 0.9375rem;
  --fs-base: 1rem;
  --fs-md: 1.125rem;
  --fs-lg: 1.25rem;
  --fs-xl: 1.75rem;
  --fs-2xl: 2.125rem;
  --fs-3xl: 2.5rem;
  --text-xxs: 0.75rem;
  --text-xs: 0.875rem;
  --text-sm: 0.9375rem;
  --text-base: 1rem;
  --text-md: 1.125rem;
  --text-lg: 1.25rem;
  --text-xl: 1.75rem;
  --text-2xl: 2.125rem;
  --text-3xl: 2.5rem;
}

html,
body {
  font-size: var(--fs-base);
}

article.widget {
  gap: 4px;
  padding: 2px 0;
}

article.widget:first-child {
  padding-top: 0;
}

article.widget:last-child {
  padding-bottom: 0;
}

article.widget > div,
article.widget .quota-widget {
  gap: 4px;
}

.pop-head .mark {
  font-size: 12px;
}

.btn {
  font-size: 12px;
}

.composer .prompt,
.composer textarea {
  font-size: 14px;
  line-height: 1.45;
}

.composer .send {
  font-size: 11px;
}
`;

export function applyDensity() {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
}
