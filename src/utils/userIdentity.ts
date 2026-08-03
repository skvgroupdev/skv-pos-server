const LAO_MOBILE_PHONE_PATTERN = /^20\d{8}$/;

export const normalizeUsername = (value: unknown) =>
  String(value || "").trim().toLowerCase().replace(/\s+/g, "");

export const normalizeLaoMobilePhone = (value: unknown) => {
  let digits = String(value || "").replace(/\D/g, "");

  if (digits.startsWith("856")) {
    digits = digits.slice(3);
  }
  if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  return LAO_MOBILE_PHONE_PATTERN.test(digits) ? digits : "";
};

export const buildLoosePhoneRegex = (normalizedPhone: string) =>
  new RegExp(`${normalizedPhone.split("").join("\\D*")}$`);
