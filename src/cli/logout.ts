import { credentialsPath, deleteCredentials } from '../registry-client.js';

export async function logout(): Promise<void> {
  const removed = deleteCredentials();
  if (removed) {
    console.log(`Removed ${credentialsPath()}`);
  } else {
    console.log('Not logged in.');
  }
}
