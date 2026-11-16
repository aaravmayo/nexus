import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { initThemeToggle } from "./theme.js";

let supabase: SupabaseClient | null = null;
let currentEmail = "";

const $ = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const $$ = (selector: string) => document.querySelectorAll(selector) as NodeListOf<HTMLElement>;

let toastTimer: any;
let lastTrigger: HTMLElement | null = null;

export function notify(message: string): void {
  const toastText = $("#toast-text");
  const toast = $("#toast");
  if (!toastText || !toast) return;

  toastText.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

export async function copySnippet(): Promise<void> {
  const snippet = '<script src="./nexus.js" defer></script>';
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(snippet);
    } else {
      const text = document.createElement("textarea");
      text.value = snippet;
      text.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(text);
      text.select();
      const copied = document.execCommand("copy");
      text.remove();
      if (!copied) throw new Error("Clipboard unavailable");
    }
    notify("One-line snippet copied to clipboard.");
  } catch {
    const docsDialog = $("#docs-dialog") as HTMLDialogElement | null;
    if (docsDialog) openDialog(docsDialog, document.activeElement as HTMLElement);
    notify("Select and copy the snippet in the docs.");
  }
}

export function openDialog(dialog: HTMLDialogElement, trigger?: HTMLElement | null): void {
  closeMenu();
  if (dialog.open) return;
  lastTrigger = trigger || null;
  dialog.showModal();
  document.body.classList.add("modal-open");
}

export function closeMenu(): void {
  const nav = $("#navigation");
  const menu = $(".menu-toggle");
  if (nav) nav.classList.remove("open");
  if (menu) menu.setAttribute("aria-expanded", "false");
}

async function initAuth(): Promise<void> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();

    if (config.supabaseUrl && config.supabaseAnonKey) {
      supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

      // Check if session exists
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        // Update header login buttons to Dashboard
        $$("[data-signup], [data-mode='login']").forEach(btn => {
          btn.textContent = "Go to Dashboard →";
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.location.href = "/app.html";
          });
        });
      }
    }
  } catch (err) {
    console.warn("Auth initialization notice:", err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  initAuth();

  // Copy buttons
  $$("[data-copy]").forEach(button => button.addEventListener("click", copySnippet));

  // Mobile menu
  const menu = $(".menu-toggle");
  if (menu) {
    menu.addEventListener("click", () => {
      const open = menu.getAttribute("aria-expanded") !== "true";
      menu.setAttribute("aria-expanded", String(open));
      $("#navigation")?.classList.toggle("open", open);
    });
  }

  $$("#navigation a").forEach(link => link.addEventListener("click", closeMenu));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeMenu();
  });

  // Dialog handling
  $$("dialog").forEach(dialogEl => {
    const dialog = dialogEl as HTMLDialogElement;
    dialog.querySelectorAll("[data-close]").forEach(button => {
      button.addEventListener("click", () => dialog.close());
    });
    dialog.addEventListener("click", event => {
      const rect = dialog.getBoundingClientRect();
      if (
        event.target === dialog &&
        (event.clientX < rect.left || event.clientX > rect.right ||
         event.clientY < rect.top || event.clientY > rect.bottom)
      ) {
        dialog.close();
      }
    });
    dialog.addEventListener("close", () => {
      if (![...$$("dialog")].some(item => (item as HTMLDialogElement).open)) {
        document.body.classList.remove("modal-open");
      }
      if (lastTrigger && lastTrigger.isConnected) lastTrigger.focus();
    });
  });

  // Docs button
  $$("[data-docs]").forEach(button => {
    button.addEventListener("click", () => {
      const docs = $("#docs-dialog") as HTMLDialogElement | null;
      if (docs) openDialog(docs, button);
    });
  });

  // Signup / Login triggers
  $$("[data-signup]").forEach(button => {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      const login = button.dataset.mode === "login";
      const signupContent = $("#signup-content");
      const signupSuccess = $("#signup-success");
      const signupOtp = $("#signup-otp-step");
      const form = $("#signup-form") as HTMLFormElement | null;
      const dialog = $("#signup-dialog") as HTMLDialogElement | null;

      if (signupContent) signupContent.hidden = false;
      if (signupSuccess) signupSuccess.hidden = true;
      if (signupOtp) signupOtp.hidden = true;
      if (form) form.reset();

      const heading = $("#signup-heading");
      const description = $("#signup-description");
      const submitBtn = $("#signup-submit");

      if (heading) heading.textContent = login ? "Welcome back to Nexus." : "A better hello starts here.";
      if (description) {
        description.textContent = login
          ? "Enter your email to receive a secure sign-in code."
          : "Free beta. Enter your email to create your assistant.";
      }
      if (submitBtn && submitBtn.firstChild) {
        submitBtn.firstChild.textContent = "Send email code ";
      }

      if (dialog) openDialog(dialog, button);
    });
  });

  // OTP Form Submission
  const signupForm = $("#signup-form") as HTMLFormElement | null;
  if (signupForm) {
    signupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const emailInput = $("#email") as HTMLInputElement | null;
      const submitBtn = $("#signup-submit") as HTMLButtonElement | null;
      if (!emailInput || !emailInput.value.trim()) return;

      currentEmail = emailInput.value.trim();

      if (!supabase) {
        notify("Authentication is running in preview mode.");
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Sending code...";
      }

      try {
        const { error } = await supabase.auth.signInWithOtp({
          email: currentEmail,
          options: {
            shouldCreateUser: true
          }
        });

        if (error) {
          notify(`Error: ${error.message}`);
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Send email code ";
          }
          return;
        }

        // Show OTP code entry step
        $("#signup-content")!.hidden = true;
        $("#signup-otp-step")!.hidden = false;
        ($("#otp-code") as HTMLInputElement)?.focus();
        notify(`Verification code sent to ${currentEmail}`);
      } catch (err: unknown) {
        notify(`Failed to send code: ${err instanceof Error ? err.message : String(err)}`);
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Send email code ";
        }
      }
    });
  }

  // OTP Verify Form Submission
  const otpForm = $("#otp-form") as HTMLFormElement | null;
  if (otpForm) {
    otpForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const otpInput = $("#otp-code") as HTMLInputElement | null;
      const verifyBtn = $("#otp-verify-submit") as HTMLButtonElement | null;
      if (!otpInput || !otpInput.value.trim() || !supabase) return;

      const code = otpInput.value.trim();
      if (verifyBtn) {
        verifyBtn.disabled = true;
        verifyBtn.textContent = "Verifying...";
      }

      try {
        const { data, error } = await supabase.auth.verifyOtp({
          email: currentEmail,
          token: code,
          type: "email"
        });

        if (error || !data.session) {
          notify(`Invalid code: ${error?.message || "Please check the code and try again."}`);
          if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.textContent = "Verify & enter dashboard";
          }
          return;
        }

        notify("Sign in successful! Entering dashboard...");
        setTimeout(() => {
          window.location.href = "/app.html";
        }, 600);
      } catch (err: unknown) {
        notify(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
        if (verifyBtn) {
          verifyBtn.disabled = false;
          verifyBtn.textContent = "Verify & enter dashboard";
        }
      }
    });
  }

  // Demo scroll button
  const tryDemo = $("#try-demo");
  if (tryDemo) {
    tryDemo.addEventListener("click", () => {
      $("#demo")?.scrollIntoView({ behavior: "smooth", block: "center" });
      const input = $("#chat-preview")?.shadowRoot?.querySelector("input");
      if (input) (input as HTMLElement).focus({ preventScroll: true });
    });
  }
});
