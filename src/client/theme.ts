export type Theme = "light" | "dark";

export function getPreferredTheme(): Theme {
  const stored = localStorage.getItem("nexus-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("nexus-theme", theme);
  updateToggleIcons(theme);
}

function updateToggleIcons(theme: Theme): void {
  const moonIcons = document.querySelectorAll(".theme-icon-moon");
  const sunIcons = document.querySelectorAll(".theme-icon-sun");

  if (theme === "dark") {
    moonIcons.forEach(el => (el as HTMLElement).style.display = "none");
    sunIcons.forEach(el => (el as HTMLElement).style.display = "block");
  } else {
    moonIcons.forEach(el => (el as HTMLElement).style.display = "block");
    sunIcons.forEach(el => (el as HTMLElement).style.display = "none");
  }
}

export function initThemeToggle(selector = "#theme-toggle"): void {
  // Apply initial theme immediately
  const currentTheme = getPreferredTheme();
  applyTheme(currentTheme);

  // Bind toggle click
  const toggleBtn = document.querySelector(selector);
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const active = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const nextTheme = active === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
    });
  }

  // Listen to OS theme changes if user hasn't explicitly set preference
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (!localStorage.getItem("nexus-theme")) {
        applyTheme(e.matches ? "dark" : "light");
      }
    });
  }
}
