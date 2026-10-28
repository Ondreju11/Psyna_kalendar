import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import qrcode from "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm";

const SUPABASE_URL = "https://jlflfwjmtaxmnuzmupne.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_O7FLqxVxwnsBqRMoNS-fjQ_h2jETQuO";
const EVENT_SLUG = "bowling-2026-11-11";
// Účet 299813451/0300 ve tvaru IBAN pro QR Platbu.
const PAYMENT_IBAN = "CZ8403000000000299813451";
const PAYMENT_AMOUNT = "180.00";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const form = document.querySelector("#signup-form");
const submitButton = document.querySelector("#submit-button");
const statusElement = document.querySelector("#form-status");
const capacityElement = document.querySelector(".capacity");
const capacityCountElement = document.querySelector("#capacity-count");
const capacityCopyElement = document.querySelector("#capacity-copy");
const fullCopyElement = document.querySelector("#full-copy");
const signupHeadingElement = document.querySelector("#signup-heading");
const doneElement = document.querySelector("#signup-done");
const doneTitleElement = document.querySelector("#done-title");
const doneCopyElement = document.querySelector("#done-copy");
const paymentElement = document.querySelector("#payment");
const paymentMessageElement = document.querySelector("#payment-message");
const qrElement = document.querySelector("#qr");
const defaultSubmitLabel = submitButton.textContent;

function setStatus(message, state = "") {
  statusElement.textContent = message;

  if (state) {
    statusElement.dataset.state = state;
  } else {
    delete statusElement.dataset.state;
  }
}

function setSubmitting(isSubmitting) {
  submitButton.disabled = isSubmitting;
  submitButton.textContent = isSubmitting ? "Ukládám přihlášku..." : defaultSubmitLabel;
}

// Když je plno, formulář zmizí a čekačka jde přes Instagram.
function showFull() {
  signupHeadingElement.textContent = "Je plno";
  capacityElement.hidden = true;
  fullCopyElement.hidden = false;
  form.hidden = true;
}

function updateCapacityStatus(data) {
  const registeredCount = Number(data.registered_count ?? 0);
  const registrationLimit = Number(data.registration_limit ?? 0);
  const remainingSpots = Number(data.remaining_spots);

  if (data.is_full) {
    showFull();
    return;
  }

  capacityCountElement.textContent = `${registeredCount}/${registrationLimit}`;
  if (remainingSpots === 1) {
    capacityCopyElement.textContent = "obsazeno, zbývá poslední místo!";
  } else if (remainingSpots < 5) {
    capacityCopyElement.textContent = `obsazeno, zbývají ${remainingSpots} místa`;
  } else {
    capacityCopyElement.textContent = `obsazeno, zbývá ${remainingSpots} míst`;
  }
}

async function refreshRegistrationStatus() {
  const { data, error } = await supabase.rpc("get_event_registration_status", {
    target_event_slug: EVENT_SLUG,
  });

  if (error) {
    console.error("Failed to fetch registration status:", error);
    capacityCopyElement.textContent = "počet volných míst se nepodařilo načíst";
    return;
  }

  updateCapacityStatus(data);
}

// QR Platba (formát SPD). Zpráva bez diakritiky, protože ji některé banky komolí.
function paymentQrPayload(fullName) {
  const message = `${fullName} - bowling`
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\*/g, "")
    .slice(0, 60);

  return `SPD*1.0*ACC:${PAYMENT_IBAN}*AM:${PAYMENT_AMOUNT}*CC:CZK*MSG:${message}`;
}

function showPayment(fullName) {
  const qr = qrcode(0, "M");
  qr.addData(paymentQrPayload(fullName));
  qr.make();
  qrElement.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  paymentMessageElement.textContent = `${fullName} - bowling`;
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

form.addEventListener("submit", async (event) => {
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
    setStatus("Zadejte prosím jméno a příjmení.", "error");
    return;
  }

  if (!isValidEmail(email)) {
    setStatus("Zadejte prosím platný e-mail.", "error");
    return;
  }

  setSubmitting(true);
  setStatus("Odesílám přihlášku...");

  try {
    // Jestli je místo volné, rozhoduje databáze. Když se mezitím zaplnilo,
    // vrátí 'waitlist' a přihláška zůstane uložená jako náhradník.
    const { data: status, error } = await supabase.rpc("register_for_event", {
      target_event_slug: EVENT_SLUG,
      full_name: fullName,
      email,
    });

    if (error) {
      if (error.code === "23505") {
        setStatus(
          "Tento e-mail už je na bowling přihlášený. Se změnou pomůže Míša na Instagramu.",
          "error",
        );
        return;
      }

      setStatus("Přihlášku se nepodařilo uložit. Zkuste to prosím za chvíli znovu.", "error");
      console.error("Supabase insert failed:", error);
      return;
    }

    if (status === "waitlist") {
      doneTitleElement.textContent = "Je plno 😢";
      doneCopyElement.textContent =
        "Než jste přihlášku odeslali, obsadilo se poslední místo. Pokud chcete na čekačku, napište Míše na Instagram @misa._.pulp. Zatím nic neplaťte.";
      paymentElement.hidden = true;
    } else {
      showPayment(fullName);
    }

    document.querySelector("#signup-intro").hidden = true;
    form.hidden = true;
    doneElement.hidden = false;
    doneElement.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus("Spojení se nepodařilo navázat. Zkuste to prosím za chvíli znovu.", "error");
    console.error("Unexpected submit failure:", error);
  } finally {
    setSubmitting(false);
  }
});

void refreshRegistrationStatus();
