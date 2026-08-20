const express = require('express');
require('dotenv').config(); // <-- Loads the server's .env file
const crypto = require('crypto');
const multer = require('multer');
const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);
const fs = require('fs');
const path = require('path');
const net = require('net');

if (!process.env.PLATFORM_API_KEY || !process.env.GITHUB_WEBHOOK_SECRET) {
  console.error("❌ FATAL: Missing PLATFORM_API_KEY or GITHUB_WEBHOOK_SECRET in .env");
  process.exit(1);
}

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
const upload = multer({ dest: 'uploads/' });

// FIX 2: Strict Project ID validation (Defeats path traversal)
const isValidProjectId = (id) => typeof id === 'string' && /^proj_[a-zA-Z0-9]+$/.test(id);

// SECURITY: Prevent Command Injection
function isSafeIdentifier(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s);
}

// --- MIDDLEWARE: Block unauthorized CLI requests ---
const requireAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || '';
  const validKey = process.env.PLATFORM_API_KEY;
  if (Buffer.byteLength(apiKey) !== Buffer.byteLength(validKey) ||
      !crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(validKey))) {
    return res.status(403).json({ error: "Forbidden: Invalid API Key" });
  }
  next();
};

// --- MIDDLEWARE: Verify GitHub Webhook Cryptographic Signature ---
const verifyGitHub = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'] || '';
  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody || '').digest('hex');

  if (Buffer.byteLength(signature) !== Buffer.byteLength(digest) ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
    return res.status(403).send("Invalid signature");
  }
  next();
};


// SECURITY: Prevent Command Injection
function isSafeIdentifier(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s);
}

// INFRASTRUCTURE: Prevent Port Collisions
async function getFreePort(min, max) {
  for (let port = min; port <= max; port++) {
    const isFree = await new Promise(resolve => {
      const server = net.createServer();
      server.listen(port, () => {
        server.close(() => resolve(true));
      });
      server.on('error', () => resolve(false));
    });
    if (isFree) return port;
  }
  throw new Error("No free ports available in range.");
}


// --- CORE DEPLOYMENT ENGINE ---

// FIX 7: Make engine asynchronous
// --- THE BLUE/GREEN DEPLOYMENT ENGINE ---
async function buildAndDeploy(projectId, extractDest) {
  console.log(`\n🚀 Starting Zero-Downtime Deployment for ${projectId}...`);
  const version = Date.now(); // Unique timestamp for this build
  const imageName = `img_${projectId}`;
  const newContainerName = `live_${projectId}_${version}`;
  let buildPath = extractDest;
  const monolithConfigPath = path.join(extractDest, 'monolith.json');

  if (fs.existsSync(monolithConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(monolithConfigPath, 'utf8'));
      if (config.buildDirectory) buildPath = path.join(extractDest, config.buildDirectory);
    } catch (err) {}
  }

  const envFilePath = path.join(__dirname, 'envs', projectId + '.env');
  let envFlag = '';
  if (fs.existsSync(envFilePath)) {
    envFlag = `--env-file ${envFilePath} `;
    console.log('🔒 Injecting secure environment vault...');
  }

  try {
    // 1. Build the new image
    await execAsync(`nixpacks build ${buildPath} --name ${imageName} ${envFlag}`);
    
    // 2. Find currently running containers for this project (to stop later)
    let oldContainers = '';
    try {
      const { stdout } = await execAsync(`docker ps -q -f "name=^live_${projectId}_"`);
      oldContainers = stdout.trim();
    } catch (e) {} // Ignore if no previous containers exist

    console.log('Forging the new container...');
    // CRASH RECOVERY: --restart unless-stopped ensures it reboots if it fails overnight
    // DYNAMIC PORT: -p 0:3000 forces Docker to find a free port instead of hardcoding 3000
    await execAsync(`docker run -d --restart unless-stopped --name ${newContainerName} -p 0:3000 ${envFlag}${imageName}`);

    // HEALTH CHECK: Wait 5 seconds to see if it crashes on boot
    console.log('🩺 Running health check...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    const { stdout: status } = await execAsync(`docker inspect -f '{{.State.Running}}' ${newContainerName}`);
    
    if (status.trim() !== 'true') {
      // It crashed! Destroy the bad container and abort before touching Caddy.
      console.error('❌ Health check failed. Container crashed on startup.');
      await execAsync(`docker rm -f ${newContainerName}`);
      throw new Error('Deployment failed health check. Traffic was not routed.');
    }

    // 3. It survived. Wire up Caddy.
    const { stdout: portBuffer } = await execAsync(`docker inspect --format='{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}' ${newContainerName}`);
    const assignedPort = portBuffer.toString().trim();

    const domain = projectId + '.20.2.198.46.nip.io';
    const caddyDir = path.join(__dirname, 'caddy-configs');
    if (!fs.existsSync(caddyDir)) fs.mkdirSync(caddyDir, { recursive: true });
    
    fs.writeFileSync(path.join(caddyDir, projectId + '.caddy'), `http://${domain} {\n  reverse_proxy localhost:${assignedPort}\n}\n`);
    await execAsync('caddy reload --config ./Caddyfile', { cwd: __dirname });
    
    // 4. Gracefully retire the old container (Stop, do not delete, for rollback)
    if (oldContainers) {
      const ids = oldContainers.split('\n').join(' ');
      console.log(`Stopping previous versions: ${ids}`);
      await execAsync(`docker stop ${ids}`);
    }

    console.log('✅ Deployment live: http://' + domain);
    return domain;
  } catch (error) {
    console.error('Build Error:', error.message);
    throw error;
  }
}

// --- ROUTE 1: THE CLI DEPLOYER (ZIP) ---
app.post('/api/deploy', requireAuth, upload.single('payload'), async(req, res) => {
  const projectId = req.body.projectId;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

  console.log('⬛ CLI DEPLOYMENT INITIATED: ' + projectId);
  const zipPath = req.file.path;
  const extractDest = path.join(__dirname, 'staging', projectId);

  try {
    if (fs.existsSync(extractDest)) fs.rmSync(extractDest, { recursive: true, force: true });
    fs.mkdirSync(extractDest, { recursive: true });
    await execAsync('unzip -o ' + zipPath + ' -d ' + extractDest);
    fs.unlinkSync(zipPath);

    const domain = await buildAndDeploy(projectId, extractDest);
    res.status(200).json({ message: 'Deployment successful! Live at: http://' + domain });
  } catch (error) {
    console.error('Deployment Failed:', error.message);
    res.status(500).json({ error: 'Failed to process payload' });
  }
});

// --- ROUTE 2: THE GITHUB WEBHOOK (GIT PUSH) ---
app.post('/api/webhook', verifyGitHub, (req, res) => {
  // We pass the projectId in the webhook URL (e.g., ?projectId=proj_123)
  const projectId = req.query.projectId;
  if (!projectId) return res.status(400).send('Missing projectId parameter');

  // Acknowledge GitHub immediately so it doesn't timeout
  res.status(200).send('Webhook received. Deployment starting in background.');

  // GitHub sends the repo URL in the payload
  const repoUrl = req.body.repository?.clone_url;
  if (!repoUrl) return console.error('No repository URL found in webhook payload.');

  console.log('⬛ GITHUB PUSH DETECTED FOR: ' + projectId);
  const extractDest = path.join(__dirname, 'staging', projectId);

  try {
    // Check if it is a TRUE git repository, not just old CLI files
    const gitFolderPath = path.join(extractDest, '.git');

    if (fs.existsSync(gitFolderPath)) {
      console.log('Pulling latest code from GitHub...');
      execSync('git pull', { cwd: extractDest, stdio: 'inherit' });
    } else {
      console.log('Wiping old CLI files and cloning fresh repository...');
      if (fs.existsSync(extractDest)) fs.rmSync(extractDest, { recursive: true, force: true });
      // Create a fresh clone
      execSync('git clone ' + repoUrl + ' ' + extractDest, { stdio: 'inherit' });
}
    buildAndDeploy(projectId, extractDest);
  } catch (error) {
    console.error('GitHub Deployment Failed:', error.message);
  }
});

// --- ROUTE 3: SECRETS VAULT ---
app.post('/api/env', requireAuth, (req, res) => {
  const { projectId, envs } = req.body;
  const envDir = path.join(__dirname, 'envs');
  if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true });
  const envFilePath = path.join(envDir, projectId + '.env');
  let envContent = '';
  for (const [key, value] of Object.entries(envs)) { envContent += key + '=' + value + '\n'; }
  fs.writeFileSync(envFilePath, envContent);
  res.status(200).json({ message: 'Environment variables secured.' });
});

// --- ROUTE 4: DATABASE PROVISIONER ---
app.post('/api/db', requireAuth, async (req, res) => {
  const { dbName, dbType = 'postgres' } = req.body;

  // 1. COMMAND INJECTION GUARD
  if (!isSafeIdentifier(dbName)) {
    return res.status(400).json({ error: "Invalid database name. Use only letters, numbers, dashes, and underscores." });
  }

  // 2. CRYPTOGRAPHIC SECURE PASSWORD
  const dbId = crypto.randomBytes(3).toString('hex');
  const password = crypto.randomBytes(16).toString('hex');
  const containerName = `${dbType}_${dbName}_${dbId}`;

  let dockerCmd = '';
  let connectionString = '';

  try {
    // 3. COLLISION-FREE PORT ASSIGNMENT
    let port;
    switch(dbType) {
      case 'postgres':
        port = await getFreePort(54320, 55000);
        dockerCmd = `docker run --name ${containerName} -e POSTGRES_PASSWORD=${password} -e POSTGRES_USER=monolith -e POSTGRES_DB=${dbName} -p ${port}:5432 -d postgres:15-alpine`;
        connectionString = `postgresql://monolith:${password}@20.2.198.46:${port}/${dbName}`;
        break;
      case 'mysql':
        port = await getFreePort(43300, 44000);
        dockerCmd = `docker run --name ${containerName} -e MYSQL_ROOT_PASSWORD=${password} -e MYSQL_DATABASE=${dbName} -p ${port}:3306 -d mysql:8.0`;
        connectionString = `mysql://root:${password}@20.2.198.46:${port}/${dbName}`;
        break;
      case 'mongodb':
        port = await getFreePort(37017, 38000);
        dockerCmd = `docker run --name ${containerName} -e MONGO_INITDB_ROOT_USERNAME=admin -e MONGO_INITDB_ROOT_PASSWORD=${password} -p ${port}:27017 -d mongo:6`;
        connectionString = `mongodb://admin:${password}@20.2.198.46:${port}/?authSource=admin`;
        break;
      case 'redis':
        port = await getFreePort(60000, 61000);
        dockerCmd = `docker run --name ${containerName} -p ${port}:6379 -d redis:7-alpine --requirepass ${password}`;
        connectionString = `redis://default:${password}@20.2.198.46:${port}`;
        break;
      default:
        return res.status(400).json({ error: "Unsupported database engine." });
    }

    // 4. ASYNCHRONOUS EXECUTION (Doesn't block the Node event loop)
    exec(dockerCmd, (error, stdout, stderr) => {
      if (error) return res.status(500).json({ error: "Failed to provision database on server." });
      res.json({ message: `${dbType.toUpperCase()} Engine '${dbName}' online.`, databaseUrl: connectionString });
    });

  } catch (err) {
    res.status(500).json({ error: "Infrastructure capacity full. No ports available." });
  }
});

app.get('/api/logs', requireAuth, (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: "Project ID missing." });

  // Look for the project's log file in the staging directory
  const logFilePath = path.join(__dirname, 'staging', projectId, 'deploy.log');

  if (fs.existsSync(logFilePath)) {
    // Read the last 2000 characters to keep terminal output clean
    const logData = fs.readFileSync(logFilePath, 'utf8');
    const truncatedLogs = logData.length > 2000
        ? '... [TRUNCATED] ...\n' + logData.slice(-2000)
        : logData;

    res.json({ logs: truncatedLogs });
  } else {
    res.json({ logs: `⬛ No recent deployment logs found for ${projectId}. Run a deployment first.` });
  }
});

// --- ROLLBACK ENGINE ---
app.post('/api/rollback', requireAuth, async (req, res) => {
  const { projectId } = req.body;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });

  try {
    // 1. Get all containers for this project and sort them by timestamp (newest first)
    const { stdout } = await execAsync(`docker ps -a --format "{{.Names}}" -f "name=^live_${projectId}_"`);
    const containers = stdout.trim().split('\n').filter(Boolean);

    if (containers.length < 2) {
      return res.status(400).json({ error: 'No previous versions found to rollback to.' });
    }

    containers.sort((a, b) => {
      const tsA = parseInt(a.split('_').pop(), 10);
      const tsB = parseInt(b.split('_').pop(), 10);
      return tsB - tsA; // Descending
    });

    // 2. Find the currently running container
    let runningIndex = -1;
    for (let i = 0; i < containers.length; i++) {
       const { stdout: state } = await execAsync(`docker inspect -f '{{.State.Running}}' ${containers[i]}`);
       if (state.trim() === 'true') {
         runningIndex = i;
         break;
       }
    }

    if (runningIndex === -1) return res.status(400).json({ error: 'No active container found to rollback from.' });
    if (runningIndex + 1 >= containers.length) return res.status(400).json({ error: 'Already at the oldest available version.' });

    const currentContainer = containers[runningIndex];
    const targetContainer = containers[runningIndex + 1]; // The immediate previous version

    console.log(`⏪ Rolling back ${projectId} from ${currentContainer} to ${targetContainer}`);

    // 3. Wake up the old container and get its port
    await execAsync(`docker start ${targetContainer}`);
    const { stdout: portBuffer } = await execAsync(`docker inspect --format='{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}' ${targetContainer}`);
    const assignedPort = portBuffer.toString().trim();

    // 4. Instantly rewire Caddy
    const domain = projectId + '.20.2.198.46.nip.io';
    const caddyDir = path.join(__dirname, 'caddy-configs');
    fs.writeFileSync(path.join(caddyDir, projectId + '.caddy'), `http://${domain} {\n  reverse_proxy localhost:${assignedPort}\n}\n`);
    await execAsync('caddy reload --config ./Caddyfile', { cwd: __dirname });

    // 5. Put the bad container to sleep
    await execAsync(`docker stop ${currentContainer}`);

    res.json({ message: `⏪ Successfully rolled back to previous version.`, domain });
  } catch (error) {
    console.error('Rollback Error:', error.message);
    res.status(500).json({ error: 'Failed to perform rollback.' });
  }
});


const PORT = 4000;
app.listen(PORT, () => console.log('🛡️  Monolith Receiver listening on port ' + PORT));