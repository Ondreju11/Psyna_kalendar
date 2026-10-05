import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://jlflfwjmtaxmnuzmupne.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_O7FLqxVxwnsBqRMoNS-fjQ_h2jETQuO";
const EVENT_SLUG = "krvava-hodina-2026-10-20";
const CANCEL_COPY =
  "Kdybyste nakonec nemohli dorazit, dejte mi prosím vědět na Facebooku nebo na ondrej.ulrich11@gmail.com, ať místo může dostat někdo jiný.";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const form = document.querySelector("#signup-form");
const submitButton = document.querySelector("#submit-button");
const signupHeadingElement = document.querySelector("#signup-heading");
const signupCopyElement = document.querySelector("#signup-copy");
const statusElement = document.querySelector("#form-status");
const capacityCountElement = document.querySelector("#capacity-count");
const capacityCopyElement = document.querySelector("#capacity-copy");
const capacityBarFillElement = document.querySelector("#capacity-bar-fill");
const successCalendarLink = document.querySelector("#calendar-link-success");
let isWaitlistMode = false;

function setStatus(message, state = "") {
  statusElement.textContent = message;

  if (state) {
    statusElement.dataset.state = state;
  } else {
    delete statusElement.dataset.state;
  }
}

function submitLabel() {
  return isWaitlistMode
    ? "Přihlásit se jako náhradník"
    : "Přihlásit se na Krvavou hodinu";
}

function setSubmitting(isSubmitting) {
  submitButton.disabled = isSubmitting;
  submitButton.textContent = isSubmitting ? "Ukládám přihlášku..." : submitLabel();
}

// Po naplnění kapacity formulář zůstává, jen se z něj stává přihláška náhradníka.
function setWaitlistMode(enabled) {
  isWaitlistMode = enabled;

  if (signupHeadingElement) {
    signupHeadingElement.textContent = enabled
      ? "Kapacita je plná"
      : "Zajistěte si místo";
  }

  if (signupCopyElement) {
    signupCopyElement.textContent = enabled
      ? "Všech 15 míst je obsazených, ale můžete se přihlásit jako náhradník. Když se místo uvolní, dáme vám vědět e-mailem."
      : "Vyplňte jméno a e-mail a místo máte jisté. Pak už stačí jen dorazit včas.";
  }

  if (submitButton && !submitButton.disabled) {
    submitButton.textContent = submitLabel();
  }
}

function updateCapacityStatus(data) {
  if (!capacityCountElement || !capacityCopyElement || !data) {
    return;
  }

  const registeredCount = Number(data.registered_count ?? 0);
  const registrationLimit = Number(data.registration_limit ?? 0);
  const remainingSpots = Number(data.remaining_spots);

  capacityCountElement.textContent = `${registeredCount}/${registrationLimit}`;

  if (capacityBarFillElement && registrationLimit > 0) {
    const fillPercent = Math.min((registeredCount / registrationLimit) * 100, 100);
    capacityBarFillElement.style.width = `${fillPercent}%`;
  }

  if (data.is_full) {
    capacityCopyElement.textContent = "kapacita je naplněná · přihlaste se jako náhradník";
    return;
  }

  if (remainingSpots === 1) {
    capacityCopyElement.textContent = "zbývá poslední volné místo";
    return;
  }

  capacityCopyElement.textContent = `zbývá ${remainingSpots} volných míst`;
}

async function refreshRegistrationStatus() {
  const { data, error } = await supabase.rpc("get_event_registration_status", {
    target_event_slug: EVENT_SLUG,
  });

  if (error) {
    console.error("Failed to fetch registration status:", error);
    return null;
  }

  setWaitlistMode(Boolean(data?.is_full));
  updateCapacityStatus(data);

  return data;
}

function normalizeName(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const nameValue = formData.get("fullName");
  const emailValue = formData.get("email");
  const websiteValue = formData.get("website");
  const fullName = normalizeName(typeof nameValue === "string" ? nameValue : "");
  const email = normalizeEmail(typeof emailValue === "string" ? emailValue : "");
  const honeypot = typeof websiteValue === "string" ? websiteValue.trim() : "";

  if (honeypot) {
    setStatus("Formulář nebylo možné odeslat.", "error");
    return;
  }

  if (fullName.length < 2) {
    setStatus("Zadejte prosím celé jméno.", "error");
    return;
  }

  if (!isValidEmail(email)) {
    setStatus("Zadejte prosím platný e-mail.", "error");
    return;
  }

  setSubmitting(true);
  setStatus("Odesílám přihlášku...");

  try {
    // O tom, jestli je hráč přihlášený, nebo náhradník, rozhoduje databáze.
    const { data: status, error } = await supabase.rpc("register_for_event", {
      target_event_slug: EVENT_SLUG,
      full_name: fullName,
      email,
    });

    if (error) {
      if (error.code === "23505") {
        setStatus(
          "Tento e-mail už je na akci přihlášený. Pokud potřebujete změnu, napište pořadateli.",
          "error",
        );
        return;
      }

      setStatus(
        "Přihlášku se nepodařilo uložit. Zkuste to prosím za chvíli znovu.",
        "error",
      );
      console.error("Supabase insert failed:", error);
      return;
    }

    form.reset();

    if (status === "waitlist") {
      setStatus(
        "Kapacita je už plná, proto jste přihlášeni jako náhradník. Jakmile se uvolní místo, dáme vám vědět e-mailem.",
        "success",
      );
    } else {
      setStatus(
        `Hotovo. Přihláška je uložená, těšíme se na vás 20. 10. 2026 v 18:15. ${CANCEL_COPY}`,
        "success",
      );
    }

    successCalendarLink.hidden = status === "waitlist";

    await refreshRegistrationStatus();
  } catch (error) {
    setStatus(
      "Spojení se nepodařilo navázat. Zkuste to prosím za chvíli znovu.",
      "error",
    );
    console.error("Unexpected submit failure:", error);
  } finally {
    setSubmitting(false);
  }
});

void refreshRegistrationStatus();
