import {
  LIMITS,
  ROLE_IDS,
  docsRepoPath,
  loadConfig,
  permissionModeFor,
  roleSettingsFor,
  saveConfig,
  targetRoles,
  validBranch,
  validCheckFiles,
  validChecks,
  validEffort,
  validGateMode,
  validGlobs,
  validInt,
  validLinkDirs,
  validModel,
  validPermissionMode,
  validSetup,
  type Paths,
} from './config';
import { ensureDocsRepo } from './docs-repo';
import { regenerateAgents } from './floor-cli';
import { checkFilesOf, defaultChecks, deliveryOf, gateModeOf, setupOf, type Profiles } from './profiles';
import { record } from './state-machine';
import type { FloorConfig, HubText, OfficeConfig, RoleId, RoleSettings, SettingsFloor, SettingsResult, SettingsTarget, SettingsView } from './types';

export function permissionTargets(config: OfficeConfig): string[] {
  const targets = ['direccion'];
  if (config.departments.redaccion) targets.push('redaccion');
  if (config.departments.mantenimiento) targets.push('mantenimiento');
  for (const [slug, floor] of Object.entries(config.floors).sort(([a], [b]) => a.localeCompare(b))) {
    if (floor.managed) targets.push(slug);
  }
  return targets;
}

const TARGET_LABELS: Record<string, string> = { redaccion: 'Redacción', mantenimiento: 'Mantenimiento' };

function settingsTargets(config: OfficeConfig): SettingsTarget[] {
  return permissionTargets(config)
    .filter((id) => id !== 'direccion')
    .map((id) => ({
      id,
      label: TARGET_LABELS[id] ?? id,
      stack: config.floors[id]?.stack ?? null,
      roles: [...targetRoles(id)],
    }));
}

function settingsFloor(slug: string, floor: FloorConfig, profiles?: Profiles): SettingsFloor {
  const hasChecks = floor.checks !== undefined;
  return {
    slug,
    path: floor.path,
    stack: floor.stack,
    managed: floor.managed,
    baseBranch: floor.baseBranch,
    checks: { mode: hasChecks ? 'custom' : 'default', list: hasChecks ? structuredClone(floor.checks ?? []) : defaultChecks(floor.path, floor.stack) },
    setup: floor.setup === undefined ? { mode: 'default', command: setupOf(floor) } : floor.setup === null ? { mode: 'none', command: null } : { mode: 'custom', command: floor.setup },
    linkDirs: [...(floor.linkDirs ?? [])],
    delivery: deliveryOf(floor),
    gateMode: floor.gateMode ?? null,
    effectiveGateMode: gateModeOf(floor),
    checkFiles: [...(floor.checkFiles ?? [])],
    profileCheckFiles: profiles ? checkFilesOf(profiles, { stack: floor.stack }) : [],
  };
}

export function settingsView(config: OfficeConfig, profiles?: Profiles): SettingsView {
  const permissionModes: SettingsView['permissionModes'] = {};
  for (const slug of permissionTargets(config)) permissionModes[slug] = permissionModeFor(config, slug);
  return {
    roles: structuredClone(config.roles),
    floorRoles: structuredClone(config.floorRoles),
    targets: settingsTargets(config),
    departments: { ...config.departments },
    review: { ...config.review },
    memory: { ...config.memory },
    limits: { ...config.limits },
    docsRepo: config.docsRepo,
    port: config.port,
    permissionModes,
    leaveAfterMinutes: config.leaveAfterMinutes,
    checksConfig: { ...config.checksConfig },
    worktrees: { ...config.worktrees },
    checkpoints: { ...config.checkpoints, skipGlobs: [...config.checkpoints.skipGlobs] },
    floors: Object.entries(config.floors)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, f]) => settingsFloor(slug, f, profiles)),
  };
}

export function applySettings(config: OfficeConfig, raw: unknown): { config: OfficeConfig; changed: boolean } | { error: HubText[] } {
  const update = record(raw);
  const next = structuredClone(config);
  const errors: HubText[] = [];
  const roles = record(update.roles);
  for (const [id, value] of Object.entries(roles)) {
    if (!(ROLE_IDS as readonly string[]).includes(id)) {
      errors.push({ key: 'hub.settings.unknownRole', params: { id } });
      continue;
    }
    const r = record(value);
    const role = next.roles[id as keyof OfficeConfig['roles']];
    if (r.model !== undefined) {
      if (validModel(r.model)) role.model = r.model;
      else errors.push({ key: 'hub.settings.badModel', params: { id } });
    }
    if (r.effort !== undefined) {
      if (validEffort(r.effort)) role.effort = r.effort;
      else errors.push({ key: 'hub.settings.badEffort', params: { id } });
    }
  }
  const allowedTargets = new Set(['direccion', 'redaccion', 'mantenimiento', ...Object.keys(next.floors)]);
  for (const [target, value] of Object.entries(record(update.floorRoles))) {
    if (target === 'direccion' || !allowedTargets.has(target)) {
      errors.push({ key: 'hub.settings.noFloor', params: { slug: target } });
      continue;
    }
    for (const [id, change] of Object.entries(record(value))) {
      if (!(ROLE_IDS as readonly string[]).includes(id)) {
        errors.push({ key: 'hub.settings.unknownRole', params: { id } });
        continue;
      }
      if (!targetRoles(target).includes(id as RoleId)) {
        errors.push({ key: 'hub.settings.roleNotOnFloor', params: { id, slug: target } });
        continue;
      }
      const roleId = id as RoleId;
      if (change === null) {
        const overrides = next.floorRoles[target];
        if (overrides) {
          delete overrides[roleId];
          if (Object.keys(overrides).length === 0) delete next.floorRoles[target];
        }
        continue;
      }
      if (typeof change !== 'object' || Array.isArray(change)) {
        errors.push({ key: 'hub.settings.badFloorRole', params: { id, slug: target } });
        continue;
      }
      const r = record(change);
      const merged: RoleSettings = { ...roleSettingsFor(next, target, roleId) };
      let valid = true;
      if (r.model !== undefined) {
        if (validModel(r.model)) merged.model = r.model;
        else {
          valid = false;
          errors.push({ key: 'hub.settings.badFloorModel', params: { id, slug: target } });
        }
      }
      if (r.effort !== undefined) {
        if (validEffort(r.effort)) merged.effort = r.effort;
        else {
          valid = false;
          errors.push({ key: 'hub.settings.badFloorEffort', params: { id, slug: target } });
        }
      }
      if (valid && (r.model !== undefined || r.effort !== undefined)) {
        next.floorRoles[target] = { ...next.floorRoles[target], [roleId]: merged };
      }
    }
  }
  const departments = record(update.departments);
  for (const key of ['redaccion', 'mantenimiento'] as const) {
    const value = departments[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') next.departments[key] = value;
    else errors.push({ key: 'hub.settings.badDepartment', params: { key } });
  }
  const review = record(update.review);
  for (const key of ['maxRounds', 'maxPlanBytes', 'maxReviewerReads'] as const) {
    const value = review[key];
    if (value === undefined) continue;
    if (validInt(value, LIMITS[key])) next.review[key] = value;
    else errors.push({ key: 'hub.settings.badRange', params: { key, min: LIMITS[key].min, max: LIMITS[key].max } });
  }
  const memory = record(update.memory);
  for (const key of ['maxLessons', 'maxLessonsPerSession', 'maxContextChars'] as const) {
    const value = memory[key];
    if (value === undefined) continue;
    if (validInt(value, LIMITS[key])) next.memory[key] = value;
    else errors.push({ key: 'hub.settings.badRange', params: { key, min: LIMITS[key].min, max: LIMITS[key].max } });
  }
  const limits = record(update.limits);
  for (const key of ['maxBriefsPerOrder', 'stalledAfterMinutes'] as const) {
    const value = limits[key];
    if (value === undefined) continue;
    if (validInt(value, LIMITS[key])) next.limits[key] = value;
    else errors.push({ key: 'hub.settings.badRange', params: { key, min: LIMITS[key].min, max: LIMITS[key].max } });
  }
  const floors = record(update.floors);
  for (const [slug, value] of Object.entries(floors)) {
    const floor = next.floors[slug];
    if (!floor) {
      errors.push({ key: 'hub.settings.noFloor', params: { slug } });
      continue;
    }
    const change = record(value);
    if (change.baseBranch !== undefined) {
      if (validBranch(change.baseBranch)) floor.baseBranch = change.baseBranch;
      else errors.push({ key: 'hub.settings.badBranch', params: { branch: String(change.baseBranch), slug } });
    }
    if (change.checks !== undefined) {
      const checks = record(change.checks);
      const list = checks.mode === 'custom' ? validChecks(checks.list) : null;
      if (checks.mode === 'default') delete floor.checks;
      else if (list) floor.checks = list;
      else errors.push({ key: 'hub.settings.badChecks', params: { slug } });
    }
    if (change.setup !== undefined) {
      const setup = record(change.setup);
      if (setup.mode === 'default') delete floor.setup;
      else if (setup.mode === 'none') floor.setup = null;
      else if (setup.mode === 'custom' && typeof setup.command === 'string' && validSetup(setup.command.trim())) floor.setup = setup.command.trim();
      else errors.push({ key: 'hub.settings.badSetup', params: { slug } });
    }
    if (change.linkDirs !== undefined) {
      const dirs = validLinkDirs(change.linkDirs);
      if (!dirs) errors.push({ key: 'hub.settings.badLinkDirs', params: { slug } });
      else if (dirs.length === 0) delete floor.linkDirs;
      else floor.linkDirs = dirs;
    }
    if (change.delivery !== undefined) {
      if (typeof change.delivery !== 'boolean') errors.push({ key: 'hub.settings.badDelivery', params: { slug } });
      else if (change.delivery) floor.delivery = true;
      else delete floor.delivery;
    }
    if (change.gateMode !== undefined) {
      if (change.gateMode === null) delete floor.gateMode;
      else if (validGateMode(change.gateMode)) floor.gateMode = change.gateMode;
      else errors.push({ key: 'hub.settings.badGateMode', params: { slug } });
    }
    if (change.checkFiles !== undefined) {
      const files = validCheckFiles(change.checkFiles);
      if (!files) errors.push({ key: 'hub.settings.badCheckFiles', params: { slug } });
      else if (files.length === 0) delete floor.checkFiles;
      else floor.checkFiles = files;
    }
  }
  const delivery = [
    ['checksConfig', 'timeoutMinutes', 'checksTimeoutMinutes'],
    ['checksConfig', 'maxParallel', 'checksMaxParallel'],
    ['checksConfig', 'tailBytes', 'checksTailBytes'],
    ['worktrees', 'retentionDays', 'worktreeRetentionDays'],
    ['worktrees', 'maxActivePerFloor', 'worktreeMaxActive'],
    ['worktrees', 'warnTotalGb', 'worktreeWarnGb'],
    ['checkpoints', 'maxFileKb', 'checkpointMaxFileKb'],
  ] as const;
  for (const [group, field, limit] of delivery) {
    const value = record(update[group])[field];
    if (value === undefined) continue;
    if (validInt(value, LIMITS[limit])) (next[group] as Record<string, number | string[]>)[field] = value;
    else errors.push({ key: 'hub.settings.badRange', params: { key: field, min: LIMITS[limit].min, max: LIMITS[limit].max } });
  }
  const skipGlobs = record(update.checkpoints).skipGlobs;
  if (skipGlobs !== undefined) {
    const globs = validGlobs(skipGlobs);
    if (globs) next.checkpoints.skipGlobs = globs;
    else errors.push({ key: 'hub.settings.badSkipGlobs' });
  }
  const modes = record(update.permissionModes);
  for (const [slug, mode] of Object.entries(modes)) {
    if (!allowedTargets.has(slug)) {
      errors.push({ key: 'hub.settings.noTarget', params: { slug } });
      continue;
    }
    if (validPermissionMode(mode)) next.permissionModes[slug] = mode;
    else errors.push({ key: 'hub.settings.badPermissionMode', params: { slug } });
  }
  if (update.leaveAfterMinutes !== undefined) {
    if (validInt(update.leaveAfterMinutes, LIMITS.leaveAfterMinutes)) next.leaveAfterMinutes = update.leaveAfterMinutes;
    else errors.push({ key: 'hub.settings.badRange', params: { key: 'leaveAfterMinutes', min: LIMITS.leaveAfterMinutes.min, max: LIMITS.leaveAfterMinutes.max } });
  }
  if (errors.length > 0) return { error: errors };
  return { config: next, changed: JSON.stringify(next) !== JSON.stringify(config) };
}

export type SettingsService = {
  view(): SettingsView;
  update(raw: unknown): SettingsResult;
};

export function createSettings(p: Paths, profiles: () => Profiles, onSaved: (config: OfficeConfig) => void): SettingsService {
  return {
    view: () => settingsView(loadConfig(p), profiles()),
    update: (raw) => {
      const current = loadConfig(p);
      const applied = applySettings(current, raw);
      if ('error' in applied) return { ok: false, error: applied.error };
      if (!applied.changed) return { ok: true, regenerated: 0, note: [{ key: 'hub.settings.noChanges' }] };
      const config = applied.config;
      const wantsDocs = config.departments.redaccion || config.departments.mantenimiento;
      if (wantsDocs) ensureDocsRepo(docsRepoPath(config));
      saveConfig(p, config);
      const result = regenerateAgents(p, profiles());
      const failed = result.floors.filter((f) => f.error);
      onSaved(config);
      const note: HubText[] = [
        { key: 'hub.settings.saved' },
        ...failed.map((f): HubText => ({ key: 'hub.settings.regenerateFailed', params: { slug: f.slug, error: f.text ?? f.error ?? '' } })),
      ];
      return { ok: true, regenerated: result.files, note };
    },
  };
}
