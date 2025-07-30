// Ensure this script runs after the DOM is fully loaded
document.addEventListener("DOMContentLoaded", () => {
  // --- DOM Element Caching ---
  const overlay = document.querySelector(".overlay");
  const paymentPopup = document.querySelector(".payment-popup");
  const numFormatErrorPopup = document.querySelector(".num-format-error-popup");
  const numOkayPopup = document.querySelector(".num-okay-popup"); // This is typically for "processing" or "success"
  const phoneNumberInput = document.getElementById("phoneNumber");
  const paymentForm = document.getElementById("paymentForm");
  const planDetailsElement = document.getElementById("selectedPlanDetails");
  const subscribeButtons = document.querySelectorAll(".sub-button");
  const closeButton = document.getElementById("close-button"); // Close button for the main payment popup
  const closeErrorPopupBtn = document.querySelector(
    ".num-format-error-popup button"
  ); // Close button for the error popup
  const numFormatErrorText = document.querySelector(
    ".num-format-error-popup p"
  ); // The paragraph inside the error popup

  // --- Input Element for Phone Validation ---
  // Ensure the input field for phone number exists and has the correct ID
  if (!phoneNumberInput) {
    console.error(
      "Error: Phone number input field (ID 'phoneNumber') not found."
    );
    return; // Exit if a critical element is missing
  }

  // --- Helper Functions ---

  // A helper function to manage element visibility (using 'display' for better layout flow)
  function toggleVisibility(element, isVisible) {
    if (element) {
      element.style.display = isVisible ? "flex" : "none"; // Using 'flex' for popups often helps centering
      // For overlay, 'block' might be more appropriate if it just covers the screen without flex content
      if (element === overlay) {
        element.style.display = isVisible ? "block" : "none";
      }
    }
  }

  // Function to reset all popups and the input field
  function resetUI() {
    toggleVisibility(overlay, false);
    toggleVisibility(paymentPopup, false);
    toggleVisibility(numFormatErrorPopup, false);
    toggleVisibility(numOkayPopup, false); // Hide the processing/success message

    if (phoneNumberInput) {
      phoneNumberInput.value = "";
    }
    // Reset error text in case it was modified
    if (numFormatErrorText) {
      numFormatErrorText.textContent =
        "Please enter a valid phone number (starting with 07 or 2547 and 10 digits long)."; // Default error message
    }
  }

  // Function to handle the initial popup display
  function showPaymentPopup(event) {
    // Get data directly from the clicked button
    const selectedAmount = event.target.dataset.price;
    const selectedPlan = event.target.dataset.plan;

    // Check if data attributes are present
    if (!selectedAmount || !selectedPlan) {
      console.error(
        "Error: Missing data-price or data-plan on the clicked subscribe button."
      );
      displayUserMessage(
        "An issue occurred with plan selection. Please try again.",
        "error"
      );
      return;
    }

    // Store data in the form for easy access on submission
    paymentForm.dataset.amount = selectedAmount;
    paymentForm.dataset.plan = selectedPlan;

    // Update the payment popup with the selected plan details
    if (planDetailsElement) {
      planDetailsElement.textContent = `You selected: ${selectedPlan} for Kes. ${selectedAmount}/-`;
    }

    resetUI(); // Ensure all other popups are hidden before showing this one
    toggleVisibility(overlay, true);
    toggleVisibility(paymentPopup, true);
  }

  // Function to display user-facing messages (e.g., in numFormatErrorPopup)
  function displayUserMessage(message, type = "error") {
    // Assuming numFormatErrorPopup is used for all user-facing errors
    // You might want a separate element for general messages vs phone format errors
    if (numFormatErrorText) {
      numFormatErrorText.textContent = message;
      // You could add/remove classes here for different styling if needed
      // numFormatErrorPopup.classList.add(type);
    }
    toggleVisibility(numOkayPopup, false); // Hide any processing message
    toggleVisibility(paymentPopup, false); // Hide payment form
    toggleVisibility(overlay, true);
    toggleVisibility(numFormatErrorPopup, true);
  }

  // Main function to handle payment submission and validation
  async function handlePaymentSubmission(event) {
    event.preventDefault();

    let phoneNumber = phoneNumberInput.value.trim(); // Trim whitespace

    // --- More robust Kenyan phone number validation ---
    // Should start with 07 or 2547 and be exactly 10 digits (for 07) or 12 digits (for 2547)
    const kenyanPhoneRegex = /^(07\d{8}|2547\d{8})$/;

    if (!kenyanPhoneRegex.test(phoneNumber)) {
      displayUserMessage(
        "Invalid phone number. Please enter a valid Kenyan Safaricom number (e.g., 0712345678 or 254712345678).",
        "error"
      );
      phoneNumberInput.value = ""; // Clear invalid input
      return; // Stop execution if validation fails
    }

    // Normalize phone number to 254 format for the backend API
    if (phoneNumber.startsWith("07")) {
      phoneNumber = "254" + phoneNumber.substring(1);
    }

    const amount = paymentForm.dataset.amount;
    const packageDescription = paymentForm.dataset.plan;

    // Basic check for amount and plan data from the button
    if (!amount || !packageDescription) {
      displayUserMessage(
        "Missing payment details. Please re-select your plan.",
        "error"
      );
      return;
    }

    // Hide the initial popup and show a "processing" message
    toggleVisibility(paymentPopup, false);
    toggleVisibility(overlay, true);
    toggleVisibility(numOkayPopup, true); // This popup implies "OK, processing"

    const data = {
      amount: parseFloat(amount), // Ensure amount is a number
      phone: phoneNumber,
      packageDescription: packageDescription, // Send this if your backend needs it
    };

    try {
      const response = await fetch("/api/process_payment", {
        // Removed trailing slash, usually not needed unless specifically routed that way
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        // Check both HTTP status and API's success flag
        console.log("Payment initiated successfully:", result);
        // numOkayPopup now indicates "Check your phone"
        if (numOkayPopup) {
          const okText = numOkayPopup.querySelector("p");
          if (okText) {
            okText.textContent =
              "Payment request sent! Please check your phone for the M-Pesa prompt.";
            // You might add a specific class here to style successful processing
            // numOkayPopup.classList.add('success-state');
          }
        }
        // Automatically hide after a few seconds or let the user close it
        setTimeout(resetUI, 5000); // Give user time to read success message
      } else {
        console.error("Payment failed:", result.error || result.message);
        toggleVisibility(numOkayPopup, false); // Hide processing message
        // Display a more specific error based on M-Pesa's response if available
        const errorMessage =
          result.message ||
          result.error?.ResponseDescription ||
          result.error?.errorMessage ||
          "An unexpected error occurred during payment initiation. Please try again.";
        displayUserMessage("Payment failed: " + errorMessage, "error");
        // No need to clear phoneNumberInput here, user might want to edit it
      }
    } catch (error) {
      console.error("Network error during payment initiation:", error);
      toggleVisibility(numOkayPopup, false); // Hide processing message
      displayUserMessage(
        "Could not connect to the server. Please check your internet connection.",
        "error"
      );
    }
  }

  // --- Event Listeners ---
  subscribeButtons.forEach((button) => {
    button.addEventListener("click", showPaymentPopup);
  });

  if (paymentForm) {
    paymentForm.addEventListener("submit", handlePaymentSubmission);
  }

  // Event listeners for close buttons on popups
  if (closeButton) {
    // For the main payment popup's close button
    closeButton.addEventListener("click", resetUI);
  }
  if (closeErrorPopupBtn) {
    // For the error popup's close button
    closeErrorPopupBtn.addEventListener("click", resetUI);
  }
  // Optional: Click outside popup to close (on overlay)
  if (overlay) {
    overlay.addEventListener("click", (event) => {
      // Only close if the click is directly on the overlay, not on a popup within it
      if (event.target === overlay) {
        resetUI();
      }
    });
  }

  // Initial UI reset in case the page reloads with popups active
  resetUI();
});
