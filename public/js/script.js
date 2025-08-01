const API_BASE_URL = "https://hotspot-gved.onrender.com";

document.addEventListener("DOMContentLoaded", () => {
  // --- 1. DOM Element Caching & Initial State ---
  const overlay = document.getElementById("overlay");
  const paymentPopup = document.getElementById("paymentPopup");
  const errorPopup = document.getElementById("errorPopup");
  const successPopup = document.getElementById("successPopup");

  const phoneNumberInput = document.getElementById("phoneNumber");
  const paymentForm = document.getElementById("paymentForm");
  const planDetailsElement = document.getElementById("selectedPlanDetails");
  const subscribeButtons = document.querySelectorAll(".sub-button");

  const closeButton = document.getElementById("closeButton");
  const closeErrorButton = document.getElementById("closeErrorButton");
  const closeSuccessButton = document.getElementById("closeSuccessButton");

  const errorMessageElement = document.getElementById("errorMessage");
  const successMessageElement = document.getElementById("successMessage");

  const payButton = document.getElementById("payButton");

  // Comments form elements
  const commentsForm = document.getElementById("commentsForm");
  const commentsSubmitButton = commentsForm
    ? commentsForm.querySelector('button[type="submit"]')
    : null;
  const commentsResetButton = commentsForm
    ? commentsForm.querySelector(".com-res")
    : null;
  const commentsRequiredFields = commentsForm
    ? commentsForm.querySelectorAll("[required]")
    : [];

  // Mikrotik login form elements
  const mikrotikLoginForm = document.forms.sendin;
  const mikrotikUsernameInput = document.getElementById("mikrotik_username");
  const mikrotikPasswordInput = document.getElementById("mikrotik_password");

  // Global variables
  let pollingInterval = null;
  let macAddress = null;
  let mikrotikLoginUrl = null;
  let checkoutRequestID = null;

  // Set current year in footer
  const currentYearSpan = document.getElementById("currentYear");
  if (currentYearSpan) {
    currentYearSpan.textContent = new Date().getFullYear();
  }

  // --- 2. Helper Functions ---

  function getUrlParameter(name) {
    name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
    const regex = new RegExp("[\\?&]" + name + "=([^&#]*)");
    const results = regex.exec(location.search);
    return results === null
      ? ""
      : decodeURIComponent(results[1].replace(/\+/g, " "));
  }

  function toggleVisibility(element, isVisible) {
    if (element) {
      element.classList.toggle("hidden", !isVisible);
      overlay.classList.toggle("hidden", !isVisible);
    }
  }

  function resetUI() {
    toggleVisibility(paymentPopup, false);
    toggleVisibility(errorPopup, false);
    toggleVisibility(successPopup, false);

    if (phoneNumberInput) phoneNumberInput.value = "";
    if (planDetailsElement) planDetailsElement.textContent = "";
    if (errorMessageElement) errorMessageElement.textContent = "";
    if (successMessageElement) successMessageElement.textContent = "";

    if (successPopup) {
      const h2 = successPopup.querySelector("h2");
      h2.classList.remove("text-red-400", "text-green-400", "text-blue-400");
    }

    if (payButton) {
      payButton.disabled = false;
      payButton.textContent = "Pay";
      payButton.classList.remove("opacity-50", "cursor-not-allowed");
    }

    if (commentsSubmitButton) {
      commentsSubmitButton.disabled = false;
      commentsSubmitButton.textContent = "Submit";
      commentsSubmitButton.classList.remove("opacity-50", "cursor-not-allowed");
    }

    commentsRequiredFields.forEach((field) => {
      field.classList.remove("border-red-500");
    });

    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  function displayUserMessage(message, type = "error") {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    resetUI();

    let targetPopup, targetMessageElement, targetHeading, targetButton;

    if (type === "success" || type === "processing") {
      targetPopup = successPopup;
      targetMessageElement = successMessageElement;
      targetHeading = successPopup.querySelector("h2");
      targetButton = closeSuccessButton;

      if (type === "success") {
        targetHeading.textContent = "Success!";
        targetHeading.classList.add("text-green-400");
        targetButton.textContent = "Done";
      } else {
        targetHeading.textContent = "Processing...";
        targetHeading.classList.add("text-blue-400");
        targetButton.textContent = "OK";
      }
    } else {
      targetPopup = errorPopup;
      targetMessageElement = errorMessageElement;
      targetHeading = errorPopup.querySelector("h2");
      targetButton = closeErrorButton;
      targetHeading.textContent = "Error!";
      targetHeading.classList.add("text-red-400");
      targetButton.textContent = "OK";
      targetButton.classList.remove(
        "bg-green-600",
        "hover:bg-green-700",
        "active:bg-green-800"
      );
      targetButton.classList.add(
        "bg-red-600",
        "hover:bg-red-700",
        "active:bg-red-800"
      );
    }

    if (targetMessageElement) targetMessageElement.textContent = message;
    toggleVisibility(targetPopup, true);
  }

  function showPaymentPopupHandler(event) {
    const selectedAmount = event.target.dataset.price;
    const selectedPlan = event.target.dataset.plan;

    if (!selectedAmount || !selectedPlan) {
      displayUserMessage(
        "An issue occurred with plan selection. Please try again.",
        "error"
      );
      return;
    }

    paymentForm.dataset.amount = selectedAmount;
    paymentForm.dataset.plan = selectedPlan;

    if (planDetailsElement) {
      planDetailsElement.textContent = `You selected: ${selectedPlan} for Kes. ${selectedAmount}/-`;
    }

    resetUI();
    toggleVisibility(paymentPopup, true);
  }

  function validateAndNormalizePhoneNumber(phone) {
    phone = String(phone).trim();
    const kenyanPhoneRegex = /^(0(1|7)\d{8})$/;
    if (!kenyanPhoneRegex.test(phone)) {
      return null;
    }
    return "254" + phone.substring(1);
  }

  // --- Payment Status Polling ---
  async function pollPaymentStatus() {
    if (!checkoutRequestID) return;

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/check_payment_status/${checkoutRequestID}`
      );
      const result = await response.json();

      if (
        ["Completed", "Cancelled", "Failed", "Timeout"].includes(result.status)
      ) {
        clearInterval(pollingInterval);
        pollingInterval = null;

        if (result.status === "Completed") {
          displayUserMessage(
            result.message || "Payment successful! Logging you in...",
            "processing"
          );
          await mikrotikLogin();
        } else if (result.status === "Cancelled") {
          displayUserMessage(
            result.message || "Payment was cancelled.",
            "error"
          );
        } else if (result.status === "Failed") {
          displayUserMessage(result.message || "Payment failed.", "error");
        } else if (result.status === "Timeout") {
          displayUserMessage(result.message || "Payment timed out.", "error");
        }
      }
    } catch (error) {
      clearInterval(pollingInterval);
      pollingInterval = null;
      displayUserMessage(
        "An error occurred while checking payment status. Please try again later.",
        "error"
      );
    }
  }

  // --- Mikrotik Login ---
  async function mikrotikLogin() {
    const phoneNumber = phoneNumberInput.value;
    const selectedPlan = paymentForm.dataset.plan;

    try {
      const authResponse = await fetch(`${API_BASE_URL}/api/mikrotik_auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: phoneNumber,
          macAddress: macAddress,
          package: selectedPlan,
        }),
      });
      const authResult = await authResponse.json();

      if (authResult.success) {
        mikrotikUsernameInput.value = phoneNumber;
        mikrotikPasswordInput.value = "payment-user";
        mikrotikLoginForm.action = mikrotikLoginUrl;
        mikrotikLoginForm.submit();
      } else {
        displayUserMessage(
          "Failed to log in. Please contact support.",
          "error"
        );
      }
    } catch (error) {
      displayUserMessage(
        "An error occurred during login. Please contact support.",
        "error"
      );
    }
  }

  // --- Payment Form Submission ---
  async function handlePaymentSubmission(event) {
    event.preventDefault();

    payButton.disabled = true;
    payButton.textContent = "Processing...";
    payButton.classList.add("opacity-50", "cursor-not-allowed");

    const normalizedPhone = validateAndNormalizePhoneNumber(
      phoneNumberInput.value
    );

    if (!normalizedPhone) {
      displayUserMessage(
        "Invalid phone number. Please enter a valid Kenyan mobile number starting with 07 or 01 (e.g., 0712345678).",
        "error"
      );
      return;
    }

    const amount = paymentForm.dataset.amount;
    const packageDescription = paymentForm.dataset.plan;

    if (!amount || !packageDescription) {
      displayUserMessage(
        "Missing payment details. Please re-select your plan.",
        "error"
      );
      return;
    }

    displayUserMessage(
      "Your payment request is being sent. Please check your phone for the M-Pesa prompt.",
      "processing"
    );

    const data = {
      amount: parseFloat(amount),
      phone: normalizedPhone,
      packageDescription: packageDescription,
    };

    try {
      const response = await fetch(`${API_BASE_URL}/api/process_payment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(data),
      });
      const result = await response.json();

      if (response.ok && result.checkoutRequestID) {
        checkoutRequestID = result.checkoutRequestID;
        if (pollingInterval) clearInterval(pollingInterval);
        pollingInterval = setInterval(pollPaymentStatus, 3000);
      } else {
        const errorMessage =
          result.message ||
          "An unexpected error occurred during payment. Please try again or contact support.";
        displayUserMessage("Payment failed: " + errorMessage, "error");
      }
    } catch (error) {
      displayUserMessage(
        "Could not connect to the payment service. Please check your internet connection or try again later.",
        "error"
      );
    }
  }

  // --- Comments Form Submission ---
  async function handleCommentsSubmission(event) {
    event.preventDefault();

    let allFilled = true;
    commentsRequiredFields.forEach((field) => {
      if (!field.value.trim()) {
        allFilled = false;
        field.classList.add("border-red-500");
      } else {
        field.classList.remove("border-red-500");
      }
    });

    if (!allFilled) {
      displayUserMessage(
        "Please fill in all required fields before submitting.",
        "error"
      );
      return;
    }

    commentsSubmitButton.disabled = true;
    commentsSubmitButton.textContent = "Submitting...";
    commentsSubmitButton.classList.add("opacity-50", "cursor-not-allowed");

    const formData = new FormData(commentsForm);
    const commentsData = {};
    for (let [key, value] of formData.entries()) {
      commentsData[key] = value;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/submit_comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(commentsData),
      });
      const result = await response.json();

      if (response.ok) {
        displayUserMessage(
          result.message ||
            "Thank you for your comments! We'll get back to you soon.",
          "success"
        );
        commentsForm.reset();
      } else {
        displayUserMessage(
          `Failed to submit comments: ${result.message || "Unknown error"}`,
          "error"
        );
      }
    } catch (error) {
      displayUserMessage(
        "Network error: Could not submit comments. Please try again later.",
        "error"
      );
    } finally {
      commentsSubmitButton.disabled = false;
      commentsSubmitButton.textContent = "Submit";
      commentsSubmitButton.classList.remove("opacity-50", "cursor-not-allowed");
    }
  }

  // --- 3. Initial Setup & Event Listeners ---
  function init() {
    macAddress = getUrlParameter("mac");
    mikrotikLoginUrl = getUrlParameter("link-login-only");

    if (macAddress) {
      const macContainer = document.getElementById("mac-container");
      const macSpan = document.getElementById("mac-address");
      if (macContainer && macSpan) {
        macSpan.textContent = macAddress;
        macContainer.classList.remove("hidden");
      }
    }

    subscribeButtons.forEach((button) => {
      button.addEventListener("click", showPaymentPopupHandler);
    });

    if (paymentForm) {
      paymentForm.addEventListener("submit", handlePaymentSubmission);
    }

    if (closeButton) {
      closeButton.addEventListener("click", resetUI);
    }
    if (closeErrorButton) {
      closeErrorButton.addEventListener("click", resetUI);
    }
    if (closeSuccessButton) {
      closeSuccessButton.addEventListener("click", resetUI);
    }
    if (overlay) {
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          resetUI();
        }
      });
    }

    if (commentsForm) {
      commentsForm.addEventListener("submit", handleCommentsSubmission);
    }

    if (commentsResetButton) {
      commentsResetButton.addEventListener("click", () => {
        commentsForm.reset();
        resetUI();
      });
    }
  }

  // --- 4. Additional Enhancements ---

  if (commentsForm) {
    commentsForm.addEventListener("input", (event) => {
      const target = event.target;
      if (target.matches("[required]")) {
        target.classList.toggle("border-red-500", !target.value.trim());
      }
    });

    commentsForm.addEventListener("input", () => {
      const allFilled = [...commentsRequiredFields].every((field) =>
        field.value.trim()
      );

      if (allFilled) {
        commentsSubmitButton.disabled = false;
        commentsSubmitButton.textContent = "Submit";
        commentsSubmitButton.classList.remove(
          "opacity-50",
          "cursor-not-allowed"
        );
      } else {
        commentsSubmitButton.disabled = true;
        commentsSubmitButton.textContent = "Fill all fields";
        commentsSubmitButton.classList.add("opacity-50", "cursor-not-allowed");
      }
    });
  }

  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (
      target.matches(
        'input, textarea, select, button, a[href], [tabindex]:not([tabindex="-1"])'
      )
    ) {
      target.classList.add(
        "focus:outline-none",
        "focus:ring-2",
        "focus:ring-blue-400"
      );
    }
  });
  document.addEventListener("focusout", (event) => {
    const target = event.target;
    target.classList.remove(
      "focus:outline-none",
      "focus:ring-2",
      "focus:ring-blue-400"
    );
  });

  // Scroll-to-top button
  const scrollToTopButton = document.createElement("button");
  scrollToTopButton.textContent = "↑";
  scrollToTopButton.className =
    "fixed bottom-4 right-4 bg-blue-600 text-white rounded-full w-10 h-10 flex items-center justify-center shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400";
  scrollToTopButton.style.display = "none";
  document.body.appendChild(scrollToTopButton);
  window.addEventListener("scroll", () => {
    scrollToTopButton.style.display = window.scrollY > 300 ? "flex" : "none";
  });
  scrollToTopButton.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Initialize the script
  init();
});
// --- 5. Error Handling for Missing Elements ---
