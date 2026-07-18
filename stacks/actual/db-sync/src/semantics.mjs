const CATEGORY_ROLES = new Map([
  ['Fixed obligations', 'fixed'],
  ['Flexible essentials', 'essential'],
  ['Discretionary', 'discretionary'],
  ['Sinking funds', 'sinking_fund'],
  ['Savings and investing', 'savings'],
  ['Income', 'income'],
]);

export function deriveCategoryRole(groupName) {
  const role = CATEGORY_ROLES.get(groupName);
  if (!role) throw new Error(`Unknown active category group: ${groupName}`);
  return role;
}

export function validateCategoryGroups(groups) {
  for (const group of groups) {
    if (!group.hidden) deriveCategoryRole(group.name);
  }
}
