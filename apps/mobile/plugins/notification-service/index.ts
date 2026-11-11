/**
 * Adds the Notification Service Extension that decrypts each notification on the phone (ADR-0017), and the keychain
 * group it shares with the app. Runs at `expo prebuild`, so the generated ios/ directory never needs editing.
 * See docs/ios-build/expo-and-white-label.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ExpoConfig } from 'expo/config';
import { type ConfigPlugin, withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } from 'expo/config-plugins';

/** The parts of the `xcode` library's project object used here. It ships no types. */
interface XcodeProject {
  hash: { project: { objects: Record<string, Record<string, unknown> | undefined> } };
  pbxTargetByName(name: string): unknown;
  addPbxGroup(files: string[], name: string, path: string): { uuid: string };
  addToPbxGroup(group: string, parent: string): void;
  getFirstProject(): { firstProject: { mainGroup: string } };
  addTarget(name: string, type: string, subfolder: string, bundleId: string): { uuid: string };
  addBuildPhase(files: string[], type: string, name: string, target: string): void;
  pbxXCBuildConfigurationSection(): Record<string, { buildSettings?: Record<string, string> } | string>;
  addLocalizationVariantGroup(name: string): { fileRef: string };
  addResourceFile(path: string, options: { variantGroup: boolean }, group: string): void;
}

export const TARGET = 'NotificationService';
const SOURCES = ['NotificationService.swift', 'NotificationCrypto.swift', 'PreviewKeychain.swift'];
const INFO_PLIST = `${TARGET}-Info.plist`;
const ENTITLEMENTS = `${TARGET}.entitlements`;
const FALLBACK_DEPLOYMENT_TARGET = '16.4';

/**
 * What iOS shows if the extension cannot decrypt in time, by `loc-key` from the relay. One key per event in
 * packages/notification-protocol, checked by plugins/notification-service/index.test.ts.
 */
export const PHRASES: Record<string, Record<string, string>> = {
  en: {
    OC_NEW_CONVERSATION: 'New conversation',
    OC_NEW_MESSAGE: 'New message',
    OC_CONVERSATION_ASSIGNED: 'Conversation assigned to you',
    OC_CONVERSATION_TRANSFERRED: 'Conversation transferred to you',
    OC_MENTION: 'You were mentioned',
    OC_CONVERSATION_UPDATED: 'Conversation updated',
  },
};

/** Shared by the app and the extension. The app lists its own group first, so its other keychain items stay private. */
const sharedGroup = (bundleId: string) => `$(AppIdentifierPrefix)${bundleId}.notifications`;

const escapeStrings = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

function stringsFile(phrases: Record<string, string>): string {
  return `${Object.entries(phrases)
    .map(([key, value]) => `"${key}" = "${escapeStrings(value)}";`)
    .join('\n')}\n`;
}

type PlistValue = string | PlistValue[] | { [key: string]: PlistValue };

function plist(entries: PlistValue): string {
  const value = (v: PlistValue): string => {
    if (typeof v === 'string') return `<string>${v}</string>`;
    if (Array.isArray(v)) return `<array>${v.map(value).join('')}</array>`;
    return `<dict>${Object.entries(v)
      .map(([k, inner]) => `<key>${k}</key>${value(inner)}`)
      .join('')}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${value(entries)}</plist>\n`;
}

function extensionInfoPlist(bundleId: string): string {
  return plist({
    CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
    CFBundleDisplayName: TARGET,
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
    CFBundleShortVersionString: '$(MARKETING_VERSION)',
    CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.usernotifications.service', NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).NotificationService' },
    OCKeychainGroup: sharedGroup(bundleId),
  });
}

function writeFiles(projectRoot: string, platformRoot: string, projectName: string, bundleId: string): void {
  const directory = path.join(platformRoot, TARGET);
  fs.mkdirSync(directory, { recursive: true });
  const here = path.join(projectRoot, 'plugins', 'notification-service', 'ios');
  const sources = {
    'NotificationService.swift': path.join(here, 'NotificationService.swift'),
    'NotificationCrypto.swift': path.join(here, 'NotificationCrypto.swift'),
    // The same keychain code as the app's module, so both read and write the same items.
    'PreviewKeychain.swift': path.join(projectRoot, 'modules', 'notification-keys', 'ios', 'PreviewKeychain.swift'),
  };
  for (const [name, source] of Object.entries(sources)) fs.copyFileSync(source, path.join(directory, name));
  fs.writeFileSync(path.join(directory, INFO_PLIST), extensionInfoPlist(bundleId));
  fs.writeFileSync(path.join(directory, ENTITLEMENTS), plist({ 'keychain-access-groups': [sharedGroup(bundleId)] }));
  for (const [language, phrases] of Object.entries(PHRASES)) {
    const lproj = path.join(platformRoot, projectName, `${language}.lproj`);
    fs.mkdirSync(lproj, { recursive: true });
    fs.writeFileSync(path.join(lproj, 'Localizable.strings'), stringsFile(phrases));
  }
}

function mainDeploymentTarget(project: XcodeProject): string {
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const entry of Object.values(configurations)) {
    const target = typeof entry === 'object' ? entry.buildSettings?.IPHONEOS_DEPLOYMENT_TARGET : undefined;
    if (target) return String(target).replaceAll('"', '');
  }
  return FALLBACK_DEPLOYMENT_TARGET;
}

function addExtensionTarget(project: XcodeProject, config: ExpoConfig, projectName: string): void {
  const bundleId = config.ios!.bundleIdentifier!;
  if (project.pbxTargetByName(TARGET)) return;
  const objects = project.hash.project.objects;
  // The xcode library assumes these sections exist when it links a new target to the app.
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};

  const group = project.addPbxGroup([...SOURCES, INFO_PLIST, ENTITLEMENTS], TARGET, TARGET);
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);

  const target = project.addTarget(TARGET, 'app_extension', TARGET, `${bundleId}.${TARGET}`);
  project.addBuildPhase(SOURCES, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

  const deploymentTarget = mainDeploymentTarget(project);
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const entry of Object.values(configurations)) {
    const settings = typeof entry === 'object' ? entry.buildSettings : undefined;
    if (!settings || settings.PRODUCT_NAME !== `"${TARGET}"`) continue;
    Object.assign(settings, {
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${ENTITLEMENTS}`,
      CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: `"${config.ios?.buildNumber ?? '1'}"`,
      GENERATE_INFOPLIST_FILE: 'NO',
      INFOPLIST_FILE: `${TARGET}/${INFO_PLIST}`,
      IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
      MARKETING_VERSION: `"${config.version ?? '1.0.0'}"`,
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}.${TARGET}"`,
      SKIP_INSTALL: 'YES',
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
    });
  }

  // The fallback phrases belong to the app, which is where iOS looks up a `loc-key`.
  const variantGroup = project.addLocalizationVariantGroup('Localizable.strings');
  for (const language of Object.keys(PHRASES)) {
    project.addResourceFile(`${projectName}/${language}.lproj/Localizable.strings`, { variantGroup: true }, variantGroup.fileRef);
  }
}

const withNotificationService: ConfigPlugin = (config) => {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId) throw new Error('notification-service needs ios.bundleIdentifier');

  config = withEntitlementsPlist(config, (c) => {
    c.modResults['keychain-access-groups'] = [`$(AppIdentifierPrefix)${bundleId}`, sharedGroup(bundleId)];
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults.OCKeychainGroup = sharedGroup(bundleId);
    return c;
  });
  config = withDangerousMod(config, [
    'ios',
    (c) => {
      writeFiles(c.modRequest.projectRoot, c.modRequest.platformProjectRoot, c.modRequest.projectName!, bundleId);
      return c;
    },
  ]);
  config = withXcodeProject(config, (c) => {
    addExtensionTarget(c.modResults as unknown as XcodeProject, c, c.modRequest.projectName!);
    return c;
  });
  return config;
};

export default withNotificationService;
