export function normaliseVendorNumber(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function clean(value) {
  return String(value ?? '').trim();
}

export function isVendorNotApplicable(item = {}) {
  return !clean(item.Vendor) && !clean(item.VendorName) && !clean(item.VendorCategory);
}

export function isVendorConfirmed(item = {}) {
  return Boolean(clean(item.Vendor) && clean(item.VendorName) && clean(item.VendorCategory));
}

export function isVendorUnmatched(item = {}) {
  return Boolean(clean(item.Vendor) && (!clean(item.VendorName) || !clean(item.VendorCategory)));
}

export function vendorMatchState(item = {}) {
  if (isVendorNotApplicable(item)) return 'not-applicable';
  if (isVendorConfirmed(item)) return 'confirmed';
  if (isVendorUnmatched(item)) return 'unmatched';
  return 'incomplete';
}

export function buildUnmatchedVendorPatch(value) {
  const Vendor = normaliseVendorNumber(value);
  if (!Vendor) throw new Error('Enter a vendor number before keeping it unmatched');
  return { Vendor, VendorName: '', VendorCategory: '' };
}

export function buildNotApplicableVendorPatch() {
  return { Vendor: '', VendorName: '', VendorCategory: '' };
}

export function buildConfirmedVendorPatch(vendor = {}) {
  const patch = {
    Vendor: normaliseVendorNumber(vendor.Vendor),
    VendorName: clean(vendor.VendorName),
    VendorCategory: clean(vendor.VendorCategory),
  };
  if (!isVendorConfirmed(patch)) throw new Error('A confirmed vendor requires number, name and category');
  return patch;
}
