export function getStoredHfToken(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  const token = localStorage.getItem('chatealm_hf_token')?.trim();
  return token || undefined;
}
