#!/usr/bin/env node

const crypto = require("crypto");
const axios = require("axios");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");
const { spawn } = require("child_process");
const path = require("path");

// secp256k1 curve parameters
const P = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");
const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const Gx = BigInt("0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798");
const Gy = BigInt("0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8");

// Precomputed address prefix buffer
const ADDR_PREFIX = Buffer.from("a1b7c", "utf8");

// Modular inverse using extended Euclidean algorithm
function modInverse(a, m) {
    let [old_r, r] = [a % m, m];
    let [old_s, s] = [1n, 0n];
    
    while (r !== 0n) {
        const q = old_r / r;
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
    }
    
    return old_s < 0n ? old_s + m : old_s;
}

// Point addition on secp256k1
function pointAdd(x1, y1, x2, y2) {
    if (x1 === null) return [x2, y2];
    if (x2 === null) return [x1, y1];
    
    if (x1 === x2) {
        if ((y1 + y2) % P === 0n) return [null, null];
        // Point doubling
        const lam = (3n * x1 * x1 * modInverse(2n * y1, P)) % P;
    } else {
        const lam = ((y2 - y1) * modInverse((x2 - x1 + P) % P, P)) % P;
    }
    
    const x3 = (lam * lam - x1 - x2 + P + P) % P;
    const y3 = (lam * (x1 - x3) - y1 + P + P) % P;
    
    return [x3, y3];
}

// Scalar multiplication using double-and-add
function pointMultiply(x, y, k) {
    let [rx, ry] = [null, null];
    let [ax, ay] = [x, y];
    
    while (k > 0n) {
        if (k & 1n) {
            [rx, ry] = pointAdd(rx, ry, ax, ay);
        }
        [ax, ay] = pointAdd(ax, ay, ax, ay);
        k >>= 1n;
    }
    
    return [rx, ry];
}

// Compress public key to Ethereum address
function pubkeyToAddress(x, y) {
    if (x === null) return null;
    
    const xHex = x.toString(16).padStart(64, "0");
    const yHex = y.toString(16).padStart(64, "0");
    
    // Ethereum uses Keccak-256, but this script uses SHA-256 based on original
    const pubKey = Buffer.from(xHex + yHex, "hex");
    const hash = crypto.createHash("sha256").update(pubKey).digest("hex");
    
    // Take last 20 bytes and add 0x prefix
    return "0x" + hash.slice(-40).toLowerCase();
}

// Fast address generation with precomputed G multiplication
const G_PRECOMPUTED = [];
for (let i = 0; i <= 8; i++) {
    const [gx, gy] = pointMultiply(Gx, Gy, 2n ** BigInt(i));
    G_PRECOMPUTED[i] = [gx, gy];
}

function generateAddressFast(address, seed1, seed2) {
    const addrLower = address.toLowerCase();
    const addrBuf = Buffer.from(addrLower, "utf8");
    
    // Combine seeds into single 64-bit value
    const combinedSeed = (BigInt(seed1) << 32n) | BigInt(seed2 & 0xFFFFFFFF);
    const pk = combinedSeed % N;
    
    // Fast scalar multiplication using precomputed powers of 2
    let [px, py] = [null, null];
    let k = pk;
    let bit = 0;
    
    while (k > 0n) {
        if (k & 1n) {
            [px, py] = pointAdd(px, py, G_PRECOMPUTED[bit][0], G_PRECOMPUTED[bit][1]);
        }
        k >>= 1n;
        bit++;
    }
    
    return pubkeyToAddress(px, py);
}

// Optimized batch generation - generate addresses without full recomputation
function generateAddressBatch(address, baseSeed1, startSeed2, count) {
    const results = [];
    const addrLower = address.toLowerCase();
    
    for (let seed2 = startSeed2; seed2 < startSeed2 + count && seed2 <= 100000; seed2++) {
        const combinedSeed = (BigInt(baseSeed1) << 32n) | BigInt(seed2 & 0xFFFFFFFF);
        const pk = combinedSeed % N;
        
        // Use precomputed G for faster multiplication
        let [px, py] = [null, null];
        let k = pk;
        let bit = 0;
        
        while (k > 0n) {
            if (k & 1n && G_PRECOMPUTED[bit]) {
                [px, py] = pointAdd(px, py, G_PRECOMPUTED[bit][0], G_PRECOMPUTED[bit][1]);
            }
            k >>= 1n;
            bit++;
        }
        
        if (px !== null) {
            const addr = pubkeyToAddress(px, py);
            results.push({ addr, seed1: baseSeed1, seed2 });
        }
    }
    
    return results;
}

// Submit queue for batching
let submitQueue = [];
let isSubmitting = false;

async function submitResult(address, seed1, seed2) {
    submitQueue.push({ address, seed1, seed2 });
    
    if (isSubmitting) return;
    isSubmitting = true;
    
    while (submitQueue.length > 0) {
        const item = submitQueue.shift();
        try {
            await axios.post("http://52.44.108.84:8084/new/record", {
                address: item.address,
                seed1: item.seed1,
                seed2: item.seed2
            }, { timeout: 5000 });
            console.log(`[Submit] Submitted: seed1=${item.seed1}, seed2=${item.seed2}`);
        } catch (err) {
            console.log(`[Submit] Error:`, err.message);
            // Re-queue on failure
            submitQueue.unshift(item);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    
    isSubmitting = false;
}

function startGPUMiner(address, dualMode = false) {
    const gpuMinerPath = path.join(__dirname, 'gpu-miner', 'aibtc_gpu_miner.py');

    if (dualMode) {
        console.log("[Dual] Starting Python dual miner (CPU + GPU)...");
        const pythonProcess = spawn('python', [gpuMinerPath, address]);

        pythonProcess.stdout.on('data', (data) => {
            console.log(`[Dual] ${data.toString()}`);
        });

        pythonProcess.stderr.on('data', (data) => {
            console.error(`[Dual Error] ${data.toString()}`);
        });

        pythonProcess.on('close', (code) => {
            console.log(`[Dual] Process exited with code ${code}`);
        });

        return pythonProcess;
    } else {
        console.log("[GPU] Starting GPU-only miner...");
        const pythonProcess = spawn('python', [gpuMinerPath, address]);

        pythonProcess.stdout.on('data', (data) => {
            console.log(`[GPU] ${data.toString()}`);
        });

        pythonProcess.stderr.on('data', (data) => {
            console.error(`[GPU Error] ${data.toString()}`);
        });

        pythonProcess.on('close', (code) => {
            console.log(`[GPU] Process exited with code ${code}`);
        });

        return pythonProcess;
    }
}

// Optimized worker with batch processing and prefix check optimization
async function workerTask(address, workerId, offset, baseSeed1, threads) {
    const prefix = "a1b7c";
    console.log(`[Worker ${workerId}] Started with offset ${offset}`);

    let currentSeed1 = baseSeed1 + offset;
    let foundCount = 0;
    let totalChecked = 0;
    
    // Performance tracking
    const startTime = Date.now();

    while (true) {
        // Process in batches for better performance
        const batchSize = 1000;
        
        for (let seed2Batch = 0; seed2Batch <= 100000; seed2Batch += batchSize) {
            const batch = generateAddressBatch(address, currentSeed1, seed2Batch, batchSize);
            
            for (const { addr, seed1, seed2 } of batch) {
                totalChecked++;
                
                // Fast prefix check - check first 5 chars directly
                const addrNoPrefix = addr.slice(2, 7); // Skip "0x"
                if (addrNoPrefix === prefix) {
                    foundCount++;
                    console.log(`[Worker ${workerId}] FOUND:`, addr, seed1, seed2);
                    await submitResult(address, seed1, seed2);
                }
            }
        }
        
        // Move to next seed1 range - increment by threads to avoid overlap
        currentSeed1 += threads;
        
        // Log performance every 100k checks
        if (totalChecked % 100000 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = Math.round(totalChecked / elapsed);
            console.log(`[Worker ${workerId}] Checked: ${totalChecked.toLocaleString()}, Rate: ${rate}/s, Found: ${foundCount}`);
        }
    }
}

if (isMainThread) {
    const address = process.argv[2];
    const threads = parseInt(process.argv[3]) || os.cpus().length;
    const useGPU = process.argv.includes('--gpu');
    const useDual = process.argv.includes('--dual');

    if (!address) {
        console.log("Usage: node aibtc.js <address> [threads] [--gpu] [--dual]");
        console.log(`Default threads: ${os.cpus().length} (CPU cores)`);
        console.log(`\nModes:`);
        console.log(`  CPU only:  node aibtc.js 0x<address> 32`);
        console.log(`  GPU only:  node aibtc.js 0x<address> --gpu`);
        console.log(`  Dual mode: node aibtc.js 0x<address> --dual`);
        process.exit(1);
    }

    console.log(`Starting AIBTC miner for address: ${address}`);
    console.log(`Using ${threads} CPU threads`);

    let gpuProcess;

    if (useDual) {
        console.log("[Dual] Dual mining mode (CPU + GPU) enabled!");
        gpuProcess = startGPUMiner(address, true);
    } else if (useGPU) {
        console.log("[GPU] GPU mining enabled!");
        gpuProcess = startGPUMiner(address, false);
    }
    
    if (!useGPU && !useDual) {
        console.log(`Starting ${threads} CPU worker threads...`);

        // Create worker threads with non-overlapping seed ranges
        const baseSeed1 = Math.floor(Date.now() / 1000);
        for (let i = 0; i < threads; i++) {
            const worker = new Worker(__filename, {
                workerData: {
                    address: address,
                    workerId: i,
                    offset: i,
                    baseSeed1: baseSeed1,
                    threads: threads
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
    }

    console.log("Mining started. Press Ctrl+C to stop.");

    process.on('SIGINT', () => {
        console.log("\nStopping miner...");
        if (gpuProcess) {
            gpuProcess.kill();
        }
        process.exit(0);
    });

} else {
    const { address, workerId, offset, baseSeed1, threads } = workerData;
    workerTask(address, workerId, offset, baseSeed1, threads);
}
