export const ALLOWED_LICENSES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "Python-2.0"]);

export function validateLicenseMetadata(packageEntries) {
  for (const { location, metadata } of packageEntries) {
    if (!metadata?.version || !metadata?.license) throw new Error(`依赖缺少版本或许可证元数据：${location}`);
    if (!ALLOWED_LICENSES.has(metadata.license)) throw new Error(`依赖许可证未被审计或不兼容：${location} (${metadata.license})`);
  }
  return true;
}
