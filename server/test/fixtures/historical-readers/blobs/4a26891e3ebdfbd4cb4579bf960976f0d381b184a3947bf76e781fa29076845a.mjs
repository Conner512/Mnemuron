export const TASK_READ_FIELDS = Object.freeze(['goal', 'progress', 'decisions', 'blockers', 'next_steps', 'resources', 'conflicts']);
export const TASK_READ_OPTIONS = Object.freeze(['task_field', 'item_offset', 'content_offset', 'content_limit', 'canonical_version']);
export const TASK_FIELD_NOTE = 'Omitted or partial fields are not unrecorded. Only recorded=false confirms an empty canonical field; recorded=null is unknown. Typed memories and checkpoints are not canonical Task state.';

export function taskFieldAvailability(source, shown = source) {
  return Object.fromEntries(TASK_READ_FIELDS.map(field => {
    const prior = source.field_availability?.[field];
    const known = Object.hasOwn(source, field);
    const value = source[field];
    const count = !known ? null : Array.isArray(value) ? value.length
      : value == null || typeof value === 'string' && !value.trim() ? 0 : 1;
    return [field, {
      recorded: prior ? prior.recorded : known ? count > 0 : null,
      item_count: prior ? prior.item_count : count,
      returned: !Object.hasOwn(shown, field) ? 'omitted'
        : (prior && prior.returned !== 'full') || !known || JSON.stringify(value) !== JSON.stringify(shown[field]) ? 'partial' : 'full',
    }];
  }));
}
