export const LEGACY_PROTOCOL_VERSION = 'v1-tool-call' as const;
export const CURRENT_PROTOCOL_VERSION = 'v2-declarative-visual' as const;

export type LegacyReadableProtocolVersion = typeof LEGACY_PROTOCOL_VERSION;
export type RuntimeProtocolVersion = typeof CURRENT_PROTOCOL_VERSION;
export type ProtocolVersion = LegacyReadableProtocolVersion | RuntimeProtocolVersion;

export function resolveProtocolVersion(version: ProtocolVersion | null | undefined): ProtocolVersion {
  return version ?? CURRENT_PROTOCOL_VERSION;
}

export function isLegacyReadableProtocolVersion(
  version: ProtocolVersion,
): version is LegacyReadableProtocolVersion {
  return version === LEGACY_PROTOCOL_VERSION;
}

export function isRuntimeProtocolVersion(
  version: ProtocolVersion,
): version is RuntimeProtocolVersion {
  return version === CURRENT_PROTOCOL_VERSION;
}

export function assertRuntimeProtocolVersion(
  version: ProtocolVersion,
): asserts version is RuntimeProtocolVersion {
  if (!isRuntimeProtocolVersion(version)) {
    throw new Error(
      `[protocol] ${version} is legacy-readable only and cannot be used to run a session`,
    );
  }
}

export function resolveRuntimeProtocolVersion(
  version: ProtocolVersion | null | undefined,
): RuntimeProtocolVersion {
  const resolved = resolveProtocolVersion(version);
  assertRuntimeProtocolVersion(resolved);
  return resolved;
}
