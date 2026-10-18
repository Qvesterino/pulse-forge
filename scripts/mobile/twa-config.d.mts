export const DEFAULT_PACKAGE_ID: string;
export const DEFAULT_VERSION_NAME: string;
export const DEFAULT_VERSION_CODE: number;

export interface DeployOrigin {
  origin: string;
  host: string;
  startUrl: string;
  manifestUrl: string;
  iconUrl: string;
  maskableIconUrl: string;
}

export interface TwaManifest {
  packageId: string;
  host: string;
  name: string;
  launcherName: string;
  display: string;
  themeColor: string;
  navigationColor: string;
  backgroundColor: string;
  startUrl: string;
  iconUrl: string;
  maskableIconUrl: string;
  webManifestUrl: string;
  appVersionName: string;
  appVersionCode: number;
  enableNotifications: boolean;
  enableSiteSettingsShortcut: boolean;
  fallbackType: string;
  generatorApp: string;
  minSdkVersion: number;
  orientation: string;
  features: Record<string, unknown>;
  shortcuts: unknown[];
}

export interface AssetLink {
  relation: string[];
  target: {
    namespace: string;
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

export function assertPackageId(packageId: string): string;
export function normalizeDeployOrigin(deployUrl: string): DeployOrigin;
export function normalizeSha256(fingerprint: string): string;
export function buildTwaManifest(input: {
  deployUrl: string;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
}): TwaManifest;
export function buildAssetLinks(input: { packageId?: string; sha256: string }): AssetLink[];
