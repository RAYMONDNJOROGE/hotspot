// Configuration: Set your backend API base URL here
// IMPORTANT: In production, this should be your actual deployed backend URL
const API_BASE_URL = "https://hotspot-gved.onrender.com";

// Show MAC address if present in URL
document.addEventListener("DOMContentLoaded", function () {
  const urlParams = new URLSearchParams(window.location.search);
  const mac = urlParams.get("mac");
  if (mac) {
    document.getElementById("mac-address").textContent = mac;
    document.getElementById("mac-container").classList.remove("hidden");
  }
});

document.addEventListener("DOMContentLoaded", () => {
  // --- 1. DOM Element Caching ---
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
  const commentsSubmitButton = commentsForm.querySelector(
    'button[type="submit"]'
  );
  const resetCommentsButton = document.getElementById("resetCommentsButton");
  const commentsRequiredFields = commentsForm.querySelectorAll("[required]");

  // Dynamically set the current year in the footer
  const currentYearSpan = document.getElementById("currentYear");
  if (currentYearSpan) {
    currentYearSpan.textContent = new Date().getFullYear();
  }

  // Global variable to hold the polling timer
  let pollingInterval = null;

  // --- 2. Helper Functions for UI Management ---

  /**
   * Toggles the visibility of a given HTML element and the overlay.
   * @param {HTMLElement} element - The DOM element to show or hide.
   * @param {boolean} isVisible - True to show, false to hide.
   */
  function toggleVisibility(element, isVisible) {
    if (element) {
      if (isVisible) {
        element.classList.remove("hidden");
        overlay.classList.remove("hidden");
      } else {
        element.classList.add("hidden");
        overlay.classList.add("hidden");
      }
    }
  }

  /**
   * Resets the UI by hiding all popups and clearing inputs.
   */
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
      const button = successPopup.querySelector("#closeSuccessButton");
      h2.textContent = "Processing...";
      h2.classList.remove("text-red-400", "text-green-400", "text-blue-400");
      button.textContent = "OK";
      button.classList.remove(
        "bg-red-600",
        "hover:bg-red-700",
        "active:bg-red-800"
      );
      button.classList.add(
        "bg-green-600",
        "hover:bg-green-700",
        "active:bg-green-800"
      );
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

    // Clear validation styles on comments form fields
    commentsRequiredFields.forEach((field) => {
      field.classList.remove("border-red-500");
    });

    // Stop polling if active
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  /**
   * Displays a user message in the dedicated message popup (error or success).
   * @param {string} message - The message to display.
   * @param {'error' | 'success' | 'processing'} type - The type of message to display.
   */
  function displayUserMessage(message, type = "error") {
    // Clear any active polling when a new message is shown
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

  /**
   * Handles the display of the payment popup when a subscribe button is clicked.
   * @param {Event} event - The click event.
   */
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

  /**
   * Validates the phone number format for Kenyan Safaricom numbers (07xxxxxxxxx or 01xxxxxxxxx).
   * @param {string} phone - The phone number string.
   * @returns {string|null} The normalized phone number (254XXXXXXXXX) or null if invalid.
   */
  function validateAndNormalizePhoneNumber(phone) {
    phone = String(phone).trim();
    const kenyanPhoneRegex = /^(0(1|7)\d{8})$/;

    if (!kenyanPhoneRegex.test(phone)) {
      return null;
    }
    return "254" + phone.substring(1);
  }

  /**
   * Polls the backend for the payment status.
   * @param {string} checkoutRequestID - The unique ID of the payment request.
   */
  async function pollPaymentStatus(checkoutRequestID) {
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/check_payment_status/${checkoutRequestID}`
      );
      const result = await response.json();

      // Check if the status is final (Completed, Cancelled, or Failed)
      if (
        ["Completed", "Cancelled", "Failed", "Timeout"].includes(result.status)
      ) {
        // Stop polling if a final status is received
        clearInterval(pollingInterval);
        pollingInterval = null;

        // Display the final message to the user
        const messageType = result.status === "Completed" ? "success" : "error";
        displayUserMessage(result.message, messageType);
      }
    } catch (error) {
      // Stop polling on network errors to prevent infinite loops
      clearInterval(pollingInterval);
      pollingInterval = null;
      displayUserMessage(
        "An error occurred while checking payment status. Please try again later.",
        "error"
      );
    }
  }

  /**
   * Handles the payment form submission (STK push initiation).
   * @param {Event} event - The form submission event.
   */
  async function handlePaymentSubmission(event) {
    event.preventDefault();

    payButton.disabled = true;
    payButton.textContent = "Processing...";
    payButton.classList.add("opacity-50", "cursor-not-allowed");

    let phoneNumber = phoneNumberInput.value;
    const normalizedPhone = validateAndNormalizePhoneNumber(phoneNumber);

    if (!normalizedPhone) {
      displayUserMessage(
        "Invalid phone number. Please enter a valid Kenyan mobile number starting with **07** or **01** (e.g., 0712345678).",
        "error"
      );
      return;
    }
    phoneNumber = normalizedPhone;

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
      phone: phoneNumber,
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

      if (response.ok) {
        // If the payment is initiated successfully, start polling
        const checkoutRequestID = result.checkoutRequestID;
        if (checkoutRequestID) {
          // Poll every 3 seconds for the final status
          pollingInterval = setInterval(
            () => pollPaymentStatus(checkoutRequestID),
            3000
          );
        }
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

  /**
   * Handles submission of the comments form.
   * @param {Event} event - The form submission event.
   */
  async function handleCommentsSubmission(event) {
    event.preventDefault();

    // Perform validation
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
        headers: {
          "Content-Type": "application/json",
        },
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
    }
  }

  // --- 3. Event Listeners ---

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

  // Main comments form event listener
  if (commentsForm) {
    commentsForm.addEventListener("submit", handleCommentsSubmission);
  }

  // --- Comments Form Reset and Validation Feedback ---
  if (resetCommentsButton) {
    resetCommentsButton.addEventListener("click", () => {
      commentsForm.reset();
      resetUI(); // Also resets any visible popups
      displayUserMessage("Comments form has been reset.", "success");
    });
  }

  // Real-time validation feedback on input
  commentsForm.addEventListener("input", (event) => {
    const target = event.target;
    if (target.matches("[required]")) {
      if (target.value.trim()) {
        target.classList.remove("border-red-500");
      } else {
        target.classList.add("border-red-500");
      }
    }
  });

  // Toggle submit button state based on required fields
  commentsForm.addEventListener("input", () => {
    let allFilled = true;
    commentsRequiredFields.forEach((field) => {
      if (!field.value.trim()) {
        allFilled = false;
      }
    });

    if (allFilled) {
      commentsSubmitButton.disabled = false;
      commentsSubmitButton.textContent = "Submit";
      commentsSubmitButton.classList.remove("opacity-50", "cursor-not-allowed");
    } else {
      commentsSubmitButton.disabled = true;
      commentsSubmitButton.textContent = "Fill all fields";
      commentsSubmitButton.classList.add("opacity-50", "cursor-not-allowed");
    }
  });

  // --- Accessibility Enhancements ---
  document.addEventListener("focusin", (event) => {
    // Check if the focused element is a form control or button
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
});
// --- 4. Additional Enhancements ---
// Add a scroll-to-top button
const scrollToTopButton = document.createElement("button");
scrollToTopButton.textContent = "↑";
scrollToTopButton.className =
  "fixed bottom-4 right-4 bg-blue-600 text-white rounded-full w-10 h-10 flex items-center justify-center shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400";
scrollToTopButton.style.display = "none"; // Initially hidden
document.body.appendChild(scrollToTopButton);

scrollToTopButton.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});
window.addEventListener("scroll", () => {
  if (window.scrollY > 300) {
    scrollToTopButton.style.display = "flex";
  } else {
    scrollToTopButton.style.display = "none";
  }
});
