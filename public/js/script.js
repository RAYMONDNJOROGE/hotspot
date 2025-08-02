const API_BASE_URL = "https://hotspot-gved.onrender.com";

document.addEventListener("DOMContentLoaded", () => {
  // --- 1. DOM Element Caching ---
  const ui = {
    overlay: document.getElementById("overlay"),
    paymentPopup: document.getElementById("paymentPopup"),
    errorPopup: document.getElementById("errorPopup"),
    successPopup: document.getElementById("successPopup"),
    phoneNumberInput: document.getElementById("phoneNumber"),
    paymentForm: document.getElementById("paymentForm"),
    planDetailsElement: document.getElementById("selectedPlanDetails"),
    subscribeButtons: document.querySelectorAll(".sub-button"),
    closeButton: document.getElementById("closeButton"),
    closeErrorButton: document.getElementById("closeErrorButton"),
    closeSuccessButton: document.getElementById("closeSuccessButton"),
    errorMessageElement: document.getElementById("errorMessage"),
    successMessageElement: document.getElementById("successMessage"),
    payButton: document.getElementById("payButton"),
    commentsForm: document.getElementById("commentsForm"),
    mikrotikLoginForm: document.forms.sendin,
    mikrotikUsernameInput: document.getElementById("mikrotik_username"),
    mikrotikPasswordInput: document.getElementById("mikrotik_password"),
    commentsSubmitButton: null,
    commentsResetButton: null,
    commentsRequiredFields: null,
    macAddressContainer: document.getElementById("mac-container"),
    macAddressSpan: document.getElementById("mac-address"),
    currentYearSpan: document.getElementById("currentYear"),
  };

  // Assign comment form elements after initial check
  if (ui.commentsForm) {
    ui.commentsSubmitButton = ui.commentsForm.querySelector(
      'button[type="submit"]'
    );
    ui.commentsResetButton = ui.commentsForm.querySelector(".com-res");
    ui.commentsRequiredFields = ui.commentsForm.querySelectorAll("[required]");
  }

  // --- 2. State Management ---
  const state = {
    pollingInterval: null,
    macAddress: null,
    mikrotikLoginUrl: null,
    checkoutRequestID: null,
  };

  // --- 3. Helper Functions ---

  /**
   * Retrieves a URL parameter by name.
   * @param {string} name The name of the parameter.
   * @returns {string} The parameter's value or an empty string.
   */
  function getUrlParameter(name) {
    name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
    const regex = new RegExp("[\\?&]" + name + "=([^&#]*)");
    const results = regex.exec(location.search);
    return results === null
      ? ""
      : decodeURIComponent(results[1].replace(/\+/g, " "));
  }

  /**
   * Toggles the visibility of a given popup and the main overlay.
   * @param {HTMLElement} element The popup element to show/hide.
   * @param {boolean} isVisible Whether to show or hide the element.
   */
  function togglePopup(element, isVisible) {
    if (element && ui.overlay) {
      element.classList.toggle("hidden", !isVisible);
      ui.overlay.classList.toggle("hidden", !isVisible);
    }
  }

  /**
   * Resets the UI to its initial state.
   */
  function resetUI() {
    togglePopup(ui.paymentPopup, false);
    togglePopup(ui.errorPopup, false);
    togglePopup(ui.successPopup, false);

    if (ui.phoneNumberInput) ui.phoneNumberInput.value = "";
    if (ui.planDetailsElement) ui.planDetailsElement.textContent = "";

    // Reset button states
    const buttonsToReset = [ui.payButton, ui.commentsSubmitButton];
    buttonsToReset.forEach((button) => {
      if (button) {
        button.disabled = false;
        button.textContent = button === ui.payButton ? "Pay" : "Submit";
        button.classList.remove("opacity-50", "cursor-not-allowed");
      }
    });

    if (ui.commentsRequiredFields) {
      ui.commentsRequiredFields.forEach((field) =>
        field.classList.remove("border-red-500")
      );
    }

    if (state.pollingInterval) {
      clearInterval(state.pollingInterval);
      state.pollingInterval = null;
    }
  }

  /**
   * Displays a user message in a popup.
   * @param {string} message The message to display.
   * @param {string} type The type of message ('success', 'error', 'processing').
   */
  function displayUserMessage(message, type = "error") {
    resetUI();

    let targetPopup, targetMessageElement, targetHeading;
    const isSuccess = type === "success";
    const isProcessing = type === "processing";
    const isError = type === "error";

    if (isSuccess || isProcessing) {
      targetPopup = ui.successPopup;
      targetMessageElement = ui.successMessageElement;
      targetHeading = targetPopup?.querySelector("h2");
      if (targetHeading) {
        targetHeading.textContent = isSuccess ? "Success!" : "Processing...";
        targetHeading.classList.add(
          isSuccess ? "text-green-400" : "text-blue-400"
        );
      }
      ui.closeSuccessButton.textContent = isSuccess ? "Done" : "OK";
    } else if (isError) {
      targetPopup = ui.errorPopup;
      targetMessageElement = ui.errorMessageElement;
      targetHeading = targetPopup?.querySelector("h2");
      if (targetHeading) {
        targetHeading.textContent = "Error!";
        targetHeading.classList.add("text-red-400");
      }
      ui.closeErrorButton.textContent = "OK";
    }

    if (targetMessageElement) targetMessageElement.textContent = message;
    if (targetPopup) togglePopup(targetPopup, true);
  }

  /**
   * Validates and normalizes a Kenyan phone number.
   * @param {string} phone The phone number to validate.
   * @returns {string|null} The normalized phone number or null if invalid.
   */
  function validateAndNormalizePhoneNumber(phone) {
    phone = String(phone).trim();
    const kenyanPhoneRegex = /^(0(1|7)\d{8})$/;
    if (!kenyanPhoneRegex.test(phone)) return null;
    return "254" + phone.substring(1);
  }

  // --- 4. Event Handlers ---

  /**
   * Handles the click event for subscribe buttons.
   * @param {Event} event The click event.
   */
  function showPaymentPopupHandler(event) {
    const { price, plan } = event.currentTarget.dataset;

    if (!price || !plan) {
      displayUserMessage(
        "An issue occurred with plan selection. Please try again.",
        "error"
      );
      return;
    }

    ui.paymentForm.dataset.amount = price;
    ui.paymentForm.dataset.plan = plan;
    if (ui.planDetailsElement) {
      ui.planDetailsElement.textContent = `You selected: ${plan} for Kes. ${price}/-`;
    }
    resetUI();
    togglePopup(ui.paymentPopup, true);
  }

  /**
   * Handles the submission of the payment form.
   * @param {Event} event The form submission event.
   */
  async function handlePaymentSubmission(event) {
    event.preventDefault();

    ui.payButton.disabled = true;
    ui.payButton.textContent = "Processing...";
    ui.payButton.classList.add("opacity-50", "cursor-not-allowed");

    const normalizedPhone = validateAndNormalizePhoneNumber(
      ui.phoneNumberInput.value
    );
    if (!normalizedPhone) {
      displayUserMessage(
        "Invalid phone number. Please enter a valid Kenyan mobile number starting with 07 or 01 (e.g., 0712345678).",
        "error"
      );
      return;
    }

    const { amount, plan: packageDescription } = ui.paymentForm.dataset;
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
        state.checkoutRequestID = result.checkoutRequestID;
        if (state.pollingInterval) clearInterval(state.pollingInterval);
        state.pollingInterval = setInterval(pollPaymentStatus, 3000);
      } else {
        const errorMessage =
          result.message || "An unexpected error occurred. Please try again.";
        displayUserMessage("Payment failed: " + errorMessage, "error");
      }
    } catch (error) {
      displayUserMessage(
        "Network error: Could not connect to the payment service. Please check your internet connection or try again later.",
        "error"
      );
    }
  }

  /**
   * Polls the payment status from the backend.
   */
  async function pollPaymentStatus() {
    if (!state.checkoutRequestID) return;

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/check_payment_status/${state.checkoutRequestID}`
      );
      const result = await response.json();

      if (
        ["Completed", "Cancelled", "Failed", "Timeout"].includes(result.status)
      ) {
        clearInterval(state.pollingInterval);
        state.pollingInterval = null;

        if (result.status === "Completed") {
          displayUserMessage(
            result.message || "Payment successful! Logging you in...",
            "processing"
          );
          await mikrotikLogin();
        } else {
          displayUserMessage(
            result.message || `Payment ${result.status.toLowerCase()}.`,
            "error"
          );
        }
      }
    } catch (error) {
      clearInterval(state.pollingInterval);
      state.pollingInterval = null;
      displayUserMessage(
        "An error occurred while checking payment status. Please try again later.",
        "error"
      );
    }
  }

  /**
   * Performs the MikroTik login.
   */
  async function mikrotikLogin() {
    const phoneNumber = ui.phoneNumberInput.value;
    const selectedPlan = ui.paymentForm.dataset.plan;

    // Check for required MikroTik variables
    if (!state.macAddress || !state.mikrotikLoginUrl) {
      displayUserMessage(
        "Missing MikroTik session information. You may be logged in already or need to reconnect.",
        "error"
      );
      return;
    }

    try {
      const authResponse = await fetch(
        `${API_BASE_URL}/api/mikrotik/check_payment?phone=${phoneNumber}`
      );
      const authResult = await authResponse.json();

      if (authResult.success && authResult.paid) {
        ui.mikrotikUsernameInput.value = phoneNumber;
        ui.mikrotikPasswordInput.value = "payment-user";
        ui.mikrotikLoginForm.action = state.mikrotikLoginUrl;
        ui.mikrotikLoginForm.submit();
      } else {
        displayUserMessage(
          authResult.message || "Failed to log in. Please contact support.",
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

  /**
   * Handles the submission of the comments form.
   * @param {Event} event The form submission event.
   */
  async function handleCommentsSubmission(event) {
    event.preventDefault();

    ui.commentsSubmitButton.disabled = true;
    ui.commentsSubmitButton.textContent = "Submitting...";
    ui.commentsSubmitButton.classList.add("opacity-50", "cursor-not-allowed");

    const formData = new FormData(ui.commentsForm);
    const commentsData = Object.fromEntries(formData.entries());

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
        ui.commentsForm.reset();
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
      ui.commentsSubmitButton.disabled = false;
      ui.commentsSubmitButton.textContent = "Submit";
      ui.commentsSubmitButton.classList.remove(
        "opacity-50",
        "cursor-not-allowed"
      );
    }
  }

  /**
   * A unified handler for all close button events.
   */
  function handleCloseEvent() {
    resetUI();
  }

  // --- 5. Initial Setup & Event Listeners ---
  function init() {
    // Set up global variables from URL
    state.macAddress = getUrlParameter("mac");
    state.mikrotikLoginUrl = getUrlParameter("link-login-only");

    // Display MAC address if available
    if (state.macAddress && ui.macAddressContainer && ui.macAddressSpan) {
      ui.macAddressSpan.textContent = state.macAddress;
      ui.macAddressContainer.classList.remove("hidden");
    }

    // Set current year in footer
    if (ui.currentYearSpan) {
      ui.currentYearSpan.textContent = new Date().getFullYear();
    }

    // Event Listeners
    if (ui.subscribeButtons) {
      ui.subscribeButtons.forEach((button) =>
        button.addEventListener("click", showPaymentPopupHandler)
      );
    }
    if (ui.paymentForm) {
      ui.paymentForm.addEventListener("submit", handlePaymentSubmission);
    }
    if (ui.closeButton) {
      ui.closeButton.addEventListener("click", handleCloseEvent);
    }
    if (ui.closeErrorButton) {
      ui.closeErrorButton.addEventListener("click", handleCloseEvent);
    }
    if (ui.closeSuccessButton) {
      ui.closeSuccessButton.addEventListener("click", handleCloseEvent);
    }
    if (ui.overlay) {
      ui.overlay.addEventListener("click", (event) => {
        if (event.target === ui.overlay) {
          handleCloseEvent();
        }
      });
    }
    if (ui.commentsForm) {
      ui.commentsForm.addEventListener("submit", handleCommentsSubmission);
      if (ui.commentsResetButton) {
        ui.commentsResetButton.addEventListener("click", () =>
          ui.commentsForm.reset()
        );
      }
    }
  }

  // --- 6. Dynamic UI and Accessibility Enhancements ---
  if (ui.commentsForm) {
    const updateCommentsButtonState = () => {
      const allFilled = [...ui.commentsRequiredFields].every((field) =>
        field.value.trim()
      );
      ui.commentsSubmitButton.disabled = !allFilled;
      ui.commentsSubmitButton.textContent = allFilled
        ? "Submit"
        : "Fill all fields";
      ui.commentsSubmitButton.classList.toggle("opacity-50", !allFilled);
      ui.commentsSubmitButton.classList.toggle(
        "cursor-not-allowed",
        !allFilled
      );
    };

    ui.commentsForm.addEventListener("input", (event) => {
      if (event.target.matches("[required]")) {
        event.target.classList.toggle(
          "border-red-500",
          !event.target.value.trim()
        );
      }
      updateCommentsButtonState();
    });

    // Initial check for button state on page load
    updateCommentsButtonState();
  }

  // Focus-ring utility (moved to a more concise approach)
  document.addEventListener("focusin", (event) => {
    event.target.classList.add(
      "focus:outline-none",
      "focus:ring-2",
      "focus:ring-blue-400"
    );
  });
  document.addEventListener("focusout", (event) => {
    event.target.classList.remove(
      "focus:outline-none",
      "focus:ring-2",
      "focus:ring-blue-400"
    );
  });

  // Scroll-to-top button
  const scrollToTopButton = document.createElement("button");
  scrollToTopButton.innerHTML = "&#x2191;"; // Up arrow character
  scrollToTopButton.className =
    "fixed bottom-4 right-4 bg-blue-600 text-white rounded-full w-10 h-10 flex items-center justify-center shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 z-50";
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
// Ensure the script runs after the DOM is fully loaded
document.addEventListener("DOMContentLoaded", () => {
  // Initialize the script
  init();
});
