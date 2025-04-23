import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const QUICKNODE_RPC = 'https://billowing-intensive-general.solana-mainnet.quiknode.pro/55b59587a922d3031eebee9bca7cedf5e69ffbbb';
const SOLANA_CONNECTION = new Connection(QUICKNODE_RPC);

const FROM_KEY_PAIR = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
const NUM_DROPS_PER_TX = 5;
const TX_INTERVAL = 1000; // Delay in ms between transactions

interface Drop {
    owner: string,
    address: string
}

/**
 * Generates an array of transactions, each containing up to `batchSize` transfer instructions.
 * @param batchSize - The number of instructions per transaction.
 * @param dropList - List of drops, each containing walletAddress and lamport amount.
 * @param fromWallet - The public key of the sender wallet.
 * @returns An array of transactions to be processed.
 */
function generateTransactions(batchSize: number, dropList: Drop[], fromWallet: PublicKey, amount: number): Transaction[] {
    const result: Transaction[] = [];
    const txInstructions: TransactionInstruction[] = dropList.map(drop =>
        SystemProgram.transfer({
            fromPubkey: fromWallet,
            toPubkey: new PublicKey(drop.owner),
            lamports: amount * LAMPORTS_PER_SOL
        })
    );

    const numTransactions = Math.ceil(txInstructions.length / batchSize);
    for (let i = 0; i < numTransactions; i++) {
        const bulkTransaction = new Transaction();
        const lowerIndex = i * batchSize;
        const upperIndex = (i + 1) * batchSize;
        for (let j = lowerIndex; j < upperIndex; j++) {
            if (txInstructions[j]) bulkTransaction.add(txInstructions[j]);
        }
        result.push(bulkTransaction);
    }
    return result;
}

/**
 * Type guard for TransactionExpiredBlockheightExceededError.
 */
function isTransactionExpiredBlockheightExceededError(error: unknown): error is { name: string; signature: string } {
    return typeof error === "object" && error !== null && "name" in error && "signature" in error && error.name === "TransactionExpiredBlockheightExceededError";
}

/**
 * Type guard for errors with a message property.
 */
function isErrorWithMessage(error: unknown): error is { message: string } {
    return typeof error === "object" && error !== null && "message" in error && typeof (error as any).message === "string";
}


/**
 * Executes a list of transactions with staggered intervals, retries, and confirmation checks.
 * @param solanaConnection - The Solana connection object.
 * @param transactionList - List of transactions to send.
 * @param payer - The Keypair used to pay for transactions.
 * @param maxRetries - Maximum retry attempts for a failed transaction.
 * @returns A promise that resolves with an array of settled transaction results.
 */
async function executeTransactions(
    solanaConnection: Connection,
    transactionList: Transaction[],
    payer: Keypair,
    maxRetries: number = 3
): Promise<PromiseSettledResult<string>[]> {
    const results: PromiseSettledResult<string>[] = [];

    for (const [i, transaction] of transactionList.entries()) {
        let attempt = 0;
        let success = false;
        let signature: string | null = null;

        while (attempt <= maxRetries && !success) {
            try {
                console.log(`Transaction ${i + 1}/${transactionList.length}, Attempt ${attempt + 1}`);

                // Fetch a fresh blockhash and last valid block height for each attempt
                const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash();
                transaction.recentBlockhash = blockhash;

                // Check current block height
                const currentBlockHeight = await solanaConnection.getBlockHeight();
                if (currentBlockHeight > lastValidBlockHeight) {
                    throw new Error(
                        `Transaction ${i + 1} has expired: current block height ${currentBlockHeight} exceeds last valid block height ${lastValidBlockHeight}`
                    );
                }

                // Send the transaction and get the signature
                signature = await sendAndConfirmTransaction(solanaConnection, transaction, [payer], {
                    commitment: "finalized",
                });

                console.log(`Transaction ${i + 1} succeeded with signature: ${signature}`);
                success = true;
                results.push({ status: "fulfilled", value: signature });
            } catch (error) {
                if (isTransactionExpiredBlockheightExceededError(error) && signature) {
                    console.warn(`Transaction ${i + 1} exceeded block height, checking status...`);

                    // Check transaction status on-chain
                    const status = await solanaConnection.getSignatureStatus(signature, { searchTransactionHistory: true });

                    if (status?.value?.confirmationStatus === "finalized") {
                        console.log(`Transaction ${i + 1} already confirmed on-chain with signature: ${signature}`);
                        success = true;
                        results.push({ status: "fulfilled", value: signature });
                        break;
                    }
                } else if (isErrorWithMessage(error)) {
                    const signatureMatch = error.message.match(/Signature (\w+)/);
                    const errorSignature = signatureMatch ? signatureMatch[1] : null;

                    if (errorSignature) {
                        console.warn(`Transaction ${i + 1} has a signature in the error message: ${errorSignature}, checking status...`);

                        // Check transaction status on-chain
                        const status = await solanaConnection.getSignatureStatus(errorSignature, { searchTransactionHistory: true });

                        if (status?.value?.confirmationStatus === "finalized") {
                            console.log(`Transaction ${i + 1} already confirmed on-chain with signature: ${signature}`);
                            success = true;
                            results.push({ status: "fulfilled", value: errorSignature });
                            break; // Exit the retry loop as the transaction succeeded
                        }
                    }

                    console.error(`Transaction ${i + 1} failed on attempt ${attempt + 1}: ${error.message}`);
                } else {
                    console.error(`Transaction ${i + 1} failed with an unknown error.`);
                }

                attempt++;

                if (attempt > maxRetries) {
                    console.error(`Transaction ${i + 1} permanently failed after ${maxRetries} retries.`);
                    results.push({ status: "rejected", reason: error });
                } else {
                    // Wait for a short interval before retrying
                    await new Promise(resolve => setTimeout(resolve, TX_INTERVAL));
                }
            }
        }

        // Wait before proceeding to the next transaction
        if (i < transactionList.length - 1) {
            await new Promise(resolve => setTimeout(resolve, TX_INTERVAL));
        }
    }

    return results;
}

function delay(ms, message = undefined) {
    if (!message) {
        message = `Delaying for ${ms / 1000} seconds`;
    }

    return new Promise((resolve) => setTimeout(resolve, ms));
}


async function retry(cb, retries = 5) {
    try {
        const result = await cb();
        return result;
    } catch (error) {
        if (retries) {
            await delay(500 * 2 ** (5 - retries));
            return retry(cb, --retries);
        }
        throw error;
    }
}

async function retrieve(page, collection, network) {
    const { SHYFT_KEY } = process.env;

    return await retry(async () => {
        const response = await axios.get(
            "https://api.shyft.to/sol/v1/collections/get_nfts",
            {
                headers: {
                    "x-api-key": SHYFT_KEY,
                },
                params: {
                    page,
                    size: 50,
                    collection_address: collection,
                    network: "devnet" === network ? "devnet" : "mainnet-beta",
                },
            }
        );
        return response.data;
    });
}

async function handler(collection) {
    let page = 1;
    let total = Infinity;

    const nfts = [];

    while (page <= total) {
        console.error(`Retrieving page ${page}/${total}...`);
        const data = await retrieve(page, collection, 'mainnet');
        total = data.result.total_pages;
        console.error(`Page ${page++}/${total} retrieved!`);
        nfts.push(
            ...data.result.nfts.map((nft) => ({
                owner: nft.owner,
                address: nft.mint,
            }))
        );
    }


    return nfts;
}

(async () => {
    try {
        const keys = ['8A6NtZj2gJKTHuiCjoPhkXGWDb3FK4v7DAsq9GhtwAZx', 'AVZ27sUEr8BeCbfv9PwuSBbvFEnNehbDSPnBB4Y8RaRh'];
        const amount = [+process.argv.slice(2), +process.argv.slice(3)];
        let i = 0;

        for (const key of keys)
        {
            const jsonResult = await handler(key);

            const transactions = generateTransactions(NUM_DROPS_PER_TX, jsonResult, FROM_KEY_PAIR.publicKey, amount[i]);
            const results = await executeTransactions(SOLANA_CONNECTION, transactions, FROM_KEY_PAIR);

            results.forEach((result, index) => {
                if (result.status === "fulfilled") {
                    console.log(`Transaction ${index + 1} succeeded with signature: ${result.value}`);
                } else {
                    console.error(`Transaction ${index + 1} failed with error: ${result.reason}`);
                }
            });
        }

    } catch (error) {
        throw error;
    }
})();
