import crypto from "crypto";

function generatePrivateKey() {
    // Generate a 32-byte private key (store securely!)
    const PRIVATE_KEY = crypto.randomBytes(32).toString("hex");
    console.log("Private Key:", PRIVATE_KEY); // Store this securely!!
}

// Function to encrypt text
export function encryptData(data) {
    const privateKey = process.env.PRIVATE_KEY_DB;
    const iv = crypto.randomBytes(16); // Generate a new IV for each encryption
    const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(privateKey, "hex"), iv);

    let encrypted = cipher.update(data, "utf-8", "hex");
    encrypted += cipher.final("hex");

    // Return IV + encrypted content in hex format
    return iv.toString("hex") + ":" + encrypted;
}

// Function to decrypt text
export function decryptData(encryptedData) {
    const privateKey = process.env.PRIVATE_KEY_DB;
    const [iv, encryptedText] = encryptedData.split(":");

    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(privateKey, "hex"), Buffer.from(iv, "hex"));

    let decrypted = decipher.update(encryptedText, "hex", "utf-8");
    decrypted += decipher.final("utf-8");

    return decrypted;
}
