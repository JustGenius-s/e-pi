import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  PackageMutation,
  PackageProgress,
  PackageRecord,
  PackageUpdateRequest,
} from "../../../src/types/contracts";

export type PackageProgressListener = (progress: PackageProgress) => void;

export class PackageService {
  #progressListener: PackageProgressListener | undefined;

  setProgressListener(listener: PackageProgressListener | undefined): void {
    this.#progressListener = listener;
  }

  list(cwd: string): PackageRecord[] {
    return this.#manager(cwd).listConfiguredPackages();
  }

  async install(request: PackageMutation): Promise<PackageRecord[]> {
    const manager = this.#manager(request.cwd);
    await manager.installAndPersist(request.source, { local: request.scope === "project" });
    return manager.listConfiguredPackages();
  }

  async remove(request: PackageMutation): Promise<PackageRecord[]> {
    const manager = this.#manager(request.cwd);
    await manager.removeAndPersist(request.source, { local: request.scope === "project" });
    return manager.listConfiguredPackages();
  }

  async update(request: PackageUpdateRequest): Promise<PackageRecord[]> {
    const manager = this.#manager(request.cwd);
    await manager.update(request.source);
    return manager.listConfiguredPackages();
  }

  #manager(cwd: string): DefaultPackageManager {
    const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    const manager = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
    });
    manager.setProgressCallback((event) => this.#progressListener?.(event));
    return manager;
  }
}
