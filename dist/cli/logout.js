import { credentialsPath, deleteCredentials } from '../registry-client.js';
export async function logout() {
    const removed = deleteCredentials();
    if (removed) {
        console.log(`Removed ${credentialsPath()}`);
    }
    else {
        console.log('Not logged in.');
    }
}
//# sourceMappingURL=logout.js.map