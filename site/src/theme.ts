/** Light/dark toggle shared by every page. Defaults to the system preference. */
const KEY = "fitto.theme";
const root = document.documentElement;
const saved = localStorage.getItem(KEY);
if (saved === "light" || saved === "dark") root.dataset.theme = saved;

function current(): "light" | "dark" {
  const t = root.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const btn = document.getElementById("theme-toggle");
if (btn) {
  const label = () => btn.setAttribute("aria-label", current() === "dark" ? "Switch to light theme" : "Switch to dark theme");
  label();
  btn.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem(KEY, next);
    label();
  });
}
