import type {
  UpdateCleanupFailure,
  UpdateInspectionFailure,
  UpdateInstallRefusal,
  UpdateTrack,
} from "@clawtrate/core";

/** Host proof captured after the engine renamed, reopened and hashed the file. */
export interface VerifiedArtifact {
  readonly offerId: string | null;
  readonly track: UpdateTrack;
  readonly version: string;
  readonly path: string;
  readonly identity: string;
  readonly sha512: string;
  readonly size: number;
}

export interface UpdateInstaller {
  /** Build policy alone can forbid an install. This check does no I/O. */
  unavailable: UpdateInstallRefusal | null;
  completesOnQuit?: true;
  retire?(): void;
  /** Why the last inspect() returned inspection-failed, when the installer recorded it. */
  readonly inspectionFailure?: UpdateInspectionFailure | null;
  /** A copy the last inspect() made and couldn't remove; it never changes the answer. */
  readonly cleanupFailure?: UpdateCleanupFailure | null;
  inspect(file: VerifiedArtifact): Promise<UpdateInstallRefusal | null>;
  /**
   * Recheck identity, bytes and signature under protection through launch. `submitted` runs once
   * the native updater has requested the archive; until then it cannot have staged the update.
   */
  launch(
    file: VerifiedArtifact,
    signal: AbortSignal,
    handed: () => void,
    submitted?: () => void,
  ): Promise<UpdateInstallRefusal | "installer-failed" | "mac-updater-refused" | null>;
}
