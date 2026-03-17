#!/usr/bin/env node

const crypto = require("crypto");
const { ethers } = require("ethers");
const axios = require("axios");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");

// secp256k1 curve order
const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function generateAddress(address, seed1, seed2) {
    const addr = address.toLowerCase();
    const addrBuf = Buffer.from(addr, "utf8");
    const seedBuf1 = Buffer.alloc(8);
    const seedBuf2 = Buffer.alloc(8);

    seedBuf1.writeBigInt64BE(BigInt(seed1));
    seedBuf2.writeBigInt64BE(BigInt(seed2));

    const buf = Buffer.concat([addrBuf, seedBuf1, seedBuf2]);
    const hash = crypto.createHash("sha256").update(buf).digest();

    let pk = BigInt("0x" + hash.toString("hex"));
    pk = pk % N;

    let pkHex = pk.toString(16).padStart(64, "0");
    const wallet = new ethers.Wallet("0x" + pkHex);

    return wallet.address.toLowerCase();
}

async function submitResult(address, seed1, seed2) {
    try {
        await axios.post("http://52.44.108.84:8084/new/record", {
            address: address,
            seed1: seed1,
            seed2: seed2
        });
        console.log(`[Worker ${workerData?.workerId || 'main'}] Submitted: seed1=${seed1}, seed2=${seed2}`);
    } catch (err) {
        console.log(`[Worker ${workerData?.workerId || 'main'}] Submit error:`, err.message);
    }
}

async function workerTask(address, workerId, offset) {
    const prefix = "a1b7c";
    
    console.log(`[Worker ${workerId}] Started with offset ${offset}`);

    while (true) {
        let seed1 = Math.floor(Date.now()) + Math.floor(Math.random() * 1000) + offset;

        for (let seed2 = 0; seed2 <= 100000; seed2++) {
            const genAddr = generateAddress(address, seed1, seed2);
            const addr = genAddr.replace("0x", "").toLowerCase();
            const checkAddr = addr.slice(0, 10);

            if (checkAddr.includes(prefix)) {
                console.log(`[Worker ${workerId}] FOUND:`, addr, seed1, seed2);
                await submitResult(address, seed1, seed2);
            }
        }
    }
}

if (isMainThread) {
    // Main thread
    const address = process.argv[2];
    const threads = parseInt(process.argv[3]) || os.cpus().length;

    if (!address) {
        console.log("Usage: node aibtc-multi.js <address> [threads]");
        console.log(`Default threads: ${os.cpus().length} (CPU cores)`);
        process.exit(1);
    }

    console.log(`Starting AIBTC worker with ${threads} threads for address: ${address}`);
    console.log(`CPU cores available: ${os.cpus().length}`);

    // Create worker threads
    for (let i = 0; i < threads; i++) {
        const worker = new Worker(__filename, {
            workerData: {
                address: address,
                workerId: i,
                offset: i * 1000000 // Different offset for each worker
            }
        });

        worker.on("error", (err) => {
            console.error(`[Worker ${i}] Error:`, err);
        });

        worker.on("exit", (code) => {
            if (code !== 0) {
                console.error(`[Worker ${i}] Stopped with exit code ${code}`);
            }
        });
    }

    console.log("All workers started. Press Ctrl+C to stop.");

} else {
    // Worker thread
    const { address, workerId, offset } = workerData;
    workerTask(address, workerId, offset);
}
