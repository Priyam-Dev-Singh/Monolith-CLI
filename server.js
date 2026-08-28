const express = require('express');
require('dotenv').config(); // <-- Loads the server's .env file
const crypto = require('crypto');
const multer = require('multer');
const util = require('util');
const { exec, spawn} = require('child_process');
const execAsync = util.promisify(exec);
const fs = require('fs');
const path = require('path');
const net = require('net');

if (!process.env.PLATFORM_API_KEY || !process.env.GITHUB_WEBHOOK_SECRET) {
  console.error("❌ FATAL: Missing PLATFORM_API_KEY or GITHUB_WEBHOOK_SECRET in .env");
  process.exit(1);
}

const serverIp = process.env.SERVER_IP || '127.0.0.1';

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
const upload = multer({ dest: 'uploads/' });

// FIX 2: Strict Project ID validation (Defeats path traversal but allows Prisma UUIDs/CUIDs)
const isValidProjectId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);

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
// --- GITHUB WEBHOOK SECURITY ---
function verifyGitHub(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.error('❌ Webhook blocked: No signature found.');
    return res.status(403).send('No signature found');
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('❌ Webhook secret missing from server .env file.');
    return res.status(500).send('Server configuration error');
  }

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  if (signature !== digest) {
    console.error('❌ Webhook blocked: Invalid signature.');
    return res.status(403).send('Invalid signature');
  }

  next();
}

app.post('/api/webhook', verifyGitHub, async (req, res) => { // Added 'async'
  const projectId = req.query.projectId;
  if (!projectId) return res.status(400).send('Missing projectId parameter');

  // 1. Acknowledge GitHub instantly so they don't timeout
  res.status(200).send('Webhook received. Deployment starting in background.');

  const repoUrl = req.body.repository?.clone_url;
  if (!repoUrl) return console.error('No repository URL found in webhook payload.');

  console.log('⬛ GITHUB PUSH DETECTED FOR: ' + projectId);
  const extractDest = path.join(__dirname, 'staging', projectId);

  try {
    const gitFolderPath = path.join(extractDest, '.git');

    // 2. Use non-blocking async execution for Git operations
    if (fs.existsSync(gitFolderPath)) {
      console.log('Pulling latest code from GitHub...');
      await execAsync('git pull', { cwd: extractDest });
    } else {
      console.log('Wiping old CLI files and cloning fresh repository...');
      if (fs.existsSync(extractDest)) fs.rmSync(extractDest, { recursive: true, force: true });
      await execAsync(`git clone ${repoUrl} ${extractDest}`);
    }
    
    // 3. Fire the Blue/Green deployment engine
    // (We don't await this so it runs independently in the background)
    buildAndDeploy(projectId, extractDest).catch(err => console.error('Build Error:', err));
    
  } catch (error) {
    console.error('GitHub Deployment Failed:', error.message);
  }
});

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
  let dockerEnvFlag = '';
  let nixpacksEnvFlag = '';
  
  if (fs.existsSync(envFilePath)) {
    console.log('🔒 Injecting secure environment vault...');
    
    // 1. Docker wants the file path directly
    dockerEnvFlag = `--env-file ${envFilePath} `;
    
    // 2. Nixpacks wants individual --env KEY=VALUE flags
    const envLines = fs.readFileSync(envFilePath, 'utf8').split('\n').filter(line => line.trim() !== '');
    nixpacksEnvFlag = envLines.map(line => `--env ${line.trim()}`).join(' ') + ' ';
  }

  try {
    // 1. Build the new image (Using Nixpacks formatting)
    await execAsync(`nixpacks build ${buildPath} --name ${imageName} ${nixpacksEnvFlag}`);
    
    // 2. Find currently running containers for this project
    let oldContainers = '';
    try {
      const { stdout } = await execAsync(`docker ps -q -f "name=^live_${projectId}_"`);
      oldContainers = stdout.trim();
    } catch (e) {}

    console.log('Forging the new container...');
    
    // CRASH RECOVERY & DYNAMIC PORT (Using Docker formatting)
    await execAsync(`docker run -d --restart unless-stopped --name ${newContainerName} -p 0:3000 ${dockerEnvFlag}${imageName}`);
    
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

// --- ROUTE 2.5: THE NEXT.JS DASHBOARD TRIGGER ---
app.post('/api/dashboard/deploy', async (req, res) => {
  const { projectId, repoUrl, branch, rootDirectory } = req.body;

  if (!projectId || !repoUrl) {
    return res.status(400).json({ error: 'Missing projectId or repoUrl' });
  }

  console.log(`\n⬛ DASHBOARD DEPLOYMENT INITIATED: ${projectId}`);
  console.log(`--> Target: ${repoUrl} (Branch: ${branch})`);
  console.log(`--> Path: ${rootDirectory}`);

  // 2. Acknowledge immediately so Next.js doesn't hang
  res.status(202).json({ message: "Deployment signal accepted. Building..." });

  const extractDest = path.join(__dirname, 'staging', projectId);

  try {
    // 3. Wipe old data and clone fresh from GitHub
    if (fs.existsSync(extractDest)) fs.rmSync(extractDest, { recursive: true, force: true });
    
    console.log('Cloning repository...');
    const branchFlag = branch && branch !== 'main' ? `-b ${branch}` : '';
    await execAsync(`git clone ${branchFlag} ${repoUrl} ${extractDest}`);

    // 4. THE GENIUS MOVE: We dynamically create a monolith.json file
    // so your existing buildAndDeploy function handles the sub-directory naturally!
    if (rootDirectory && rootDirectory !== '/') {
      const configPath = path.join(extractDest, 'monolith.json');
      fs.writeFileSync(configPath, JSON.stringify({ buildDirectory: rootDirectory }));
    }

    // 5. Fire your existing Blue/Green Engine in the background
    buildAndDeploy(projectId, extractDest).catch(err => console.error('Build Error:', err));

  } catch (error) {
    console.error('Dashboard Deployment Failed:', error.message);
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

// --- ROUTE 3.1: READ SECRETS VAULT ---
app.get('/api/env', requireAuth, (req, res) => {
  const projectId = req.query.projectId;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
  
  const envFilePath = path.join(__dirname, 'envs', projectId + '.env');
  if (!fs.existsSync(envFilePath)) return res.json({ envs: {} });

  const envContent = fs.readFileSync(envFilePath, 'utf8');
  const envs = {};
  
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key) envs[key.trim()] = valueParts.join('=').trim();
  });
  
  res.status(200).json({ envs });
});

// --- ROUTE 3.2: DELETE SECRETS FROM VAULT ---
app.delete('/api/env', requireAuth, (req, res) => {
  const { projectId, envKey } = req.body;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
  
  const envFilePath = path.join(__dirname, 'envs', projectId + '.env');
  if (!fs.existsSync(envFilePath)) return res.status(200).json({ message: 'Vault empty.' });

  const envContent = fs.readFileSync(envFilePath, 'utf8');
  const lines = envContent.split('\n').filter(line => {
    const key = line.split('=')[0];
    return key && key.trim() !== envKey; // Keep everything EXCEPT the target key
  });

  fs.writeFileSync(envFilePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  res.status(200).json({ message: `Variable ${envKey} securely eradicated.` });
});

// --- ROUTE 4: DATABASE PROVISIONER ---
app.post('/api/db', requireAuth, async (req, res) => {
  const { dbName, dbType, projectId } = req.body;

   if (!projectId || !dbName || !dbType) {
  return res.status(400).json({ error: 'Missing parameters (projectId, dbName, dbType).' });
}
  if (!isSafeIdentifier(dbName)) {
    return res.status(400).json({ error: "Invalid database name. Use only letters, numbers, dashes, and underscores." });
  }
 

  const dbId = crypto.randomBytes(3).toString('hex');
  const password = crypto.randomBytes(16).toString('hex');
  const containerName = `db_${projectId}_${dbType}_${dbName}_${dbId}`;

  // SECURITY: Temporary Env File Setup to prevent ps aux leaking
  const dbEnvDir = path.join(__dirname, 'db-envs');
  if (!fs.existsSync(dbEnvDir)) fs.mkdirSync(dbEnvDir, { recursive: true });
  const envFilePath = path.join(dbEnvDir, `${containerName}.env`);

  let dockerCmd = '';
  let connectionString = '';
  let envContent = '';

  try {
    let port;
    switch(dbType) {
      case 'postgres':
        port = await getFreePort(54320, 55000);
        envContent = `POSTGRES_PASSWORD=${password}\nPOSTGRES_USER=monolith\nPOSTGRES_DB=${dbName}`;
        // Added: --restart unless-stopped, --env-file, and -v (Volume Persistence)
        dockerCmd = `docker run --name ${containerName} --restart unless-stopped --env-file ${envFilePath} -v ${containerName}_data:/var/lib/postgresql/data -p ${port}:5432 -d postgres:15-alpine`;
        connectionString = `postgresql://monolith:${password}@${serverIp}:${port}/${dbName}`;
        break;
      case 'mysql':
        port = await getFreePort(43300, 44000);
        envContent = `MYSQL_ROOT_PASSWORD=${password}\nMYSQL_DATABASE=${dbName}`;
        dockerCmd = `docker run --name ${containerName} --restart unless-stopped --env-file ${envFilePath} -v ${containerName}_data:/var/lib/mysql -p ${port}:3306 -d mysql:8.0`;
        connectionString = `mysql://root:${password}@${serverIp}:${port}/${dbName}`;
        break;
      case 'mongodb':
        port = await getFreePort(37017, 38000);
        envContent = `MONGO_INITDB_ROOT_USERNAME=admin\nMONGO_INITDB_ROOT_PASSWORD=${password}`;
        dockerCmd = `docker run --name ${containerName} --restart unless-stopped --env-file ${envFilePath} -v ${containerName}_data:/data/db -p ${port}:27017 -d mongo:6`;
        connectionString = `mongodb://admin:${password}@${serverIp}:${port}/?authSource=admin`;
        break;
      case 'redis':
        port = await getFreePort(60000, 61000);
        envContent = `REDIS_PASSWORD=${password}`;
        // Redis requires a custom command to ingest the password from the environment securely
        dockerCmd = `docker run --name ${containerName} --restart unless-stopped --env-file ${envFilePath} -v ${containerName}_data:/data -p ${port}:6379 -d redis:7-alpine sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD"'`;
        connectionString = `redis://default:${password}@${serverIp}:${port}`;
        break;
      default:
        return res.status(400).json({ error: "Unsupported database engine." });
    }

    // Write the secret file, strictly readable only by Node
    fs.writeFileSync(envFilePath, envContent, { mode: 0o600 });

    // CLEAN ASYNC EXECUTION (Replaces the messy callback)
    await execAsync(dockerCmd);

    res.status(200).json({ 
  message: 'Database provisioned successfully.', 
  databaseUrl: connectionString,
  containerName: containerName // Ensure this variable holds 'postgres_test-db_af3811'
});

  } catch (err) {
    console.error('DB Provisioning Error:', err);
    res.status(500).json({ error: "Failed to provision database." });
  } finally {
    // SECURITY: Docker ingests envs at creation. We instantly burn the file so it doesn't sit on the hard drive.
    if (fs.existsSync(envFilePath)) fs.unlinkSync(envFilePath);
  }
});

// --- LIVE LOG STREAMING ENGINE ---
app.get('/api/logs/stream', requireAuth, async (req, res) => {
  const projectId = req.query.projectId;
  if (!isValidProjectId(projectId)) return res.status(400).send('Invalid projectId');

  try {
    // Find the currently active container for this project
    const { stdout } = await execAsync(`docker ps -q -f "name=^live_${projectId}_"`);
    const containerId = stdout.trim().split('\n')[0];

    if (!containerId) {
      return res.status(404).send('❌ No running container found for this project.\n');
    }

    // Set headers for a continuous stream
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Spawn a process that attaches directly to the Docker daemon (-f means "follow" in real-time)
    const child = spawn('docker', ['logs', '-f', '--tail', '100', containerId]);
    
    child.stdout.on('data', data => res.write(data));
    child.stderr.on('data', data => res.write(data));

    // If the user hits Ctrl+C on their laptop, close the stream gracefully on the server
    req.on('close', () => child.kill());

  } catch (err) {
    res.status(500).send('Failed to fetch logs.\n');
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

// --- THE READ ENGINE (STATUS) ---
app.get('/api/list', requireAuth, (req, res) => {
  const { projectId } = req.query; // The Control Plane will send this

  exec('docker ps --format "{{.Names}}|{{.Status}}"', (error, stdout) => {
    if (error) return res.status(500).json({ error: 'Failed to read engine state' });
    
    const lines = stdout.trim().split('\n').filter(Boolean);
    const apps = [];
    const dbs = [];

    lines.forEach(line => {
      const [name, status] = line.split('|');
      
      // Strict Multitenancy: If a projectId is requested, hide everything else
      if (projectId && !name.includes(projectId)) return;

      // Detection Matrix: Catches new architecture (db_) AND legacy engines
      const isDatabase = name.startsWith('db_') || 
                         name.startsWith('postgres_') || 
                         name.startsWith('mysql_') || 
                         name.startsWith('mongodb_') || 
                         name.startsWith('redis_');

      if (isDatabase) {
        let engine = 'UNKNOWN';
        if (name.startsWith('db_')) {
          // Extracts 'postgres' from db_proj123_postgres_test
          engine = name.split('_')[2] || 'UNKNOWN'; 
        } else {
          // Extracts 'mongodb' from mongodb_test_persistence...
          engine = name.split('_')[0]; 
        }
        dbs.push({ engine: engine.toUpperCase(), name: name, status });
      } else {
        apps.push({ name, status });
      }
    });

    res.json({ apps, dbs });
  });
});

// --- THE DESTROY ENGINE (TEARDOWN) ---
app.post('/api/destroy', requireAuth, async (req, res) => {
  const { projectId } = req.body;
  if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });

  console.log(`\n🧨 Initiating tactical teardown for ${projectId}...`);

  try {
    // 1. Destroy all containers (legacy and blue/green backups)
    const { stdout } = await execAsync(`docker ps -a --format "{{.Names}}"`);
    const allContainers = stdout.trim().split('\n').filter(Boolean);
    
    // Target exact matches (legacy) OR timestamped matches (modern)
    const targets = allContainers.filter(name => 
      name === `live_${projectId}` || name.startsWith(`live_${projectId}_`)
    );

    if (targets.length > 0) {
      console.log(`Executing container purge: ${targets.join(', ')}`);
      await execAsync(`docker rm -f ${targets.join(' ')}`);
    }

    // 2. Eradicate Caddy route
    const caddyFile = path.join(__dirname, 'caddy-configs', `${projectId}.caddy`);
    if (fs.existsSync(caddyFile)) fs.unlinkSync(caddyFile);
    await execAsync('caddy reload --config ./Caddyfile', { cwd: __dirname }).catch(() => {});

    // 3. Burn the Env Vault
    const envFile = path.join(__dirname, 'envs', `${projectId}.env`);
    if (fs.existsSync(envFile)) fs.unlinkSync(envFile);

    // 4. Wipe the Staging folder
    const stagingDir = path.join(__dirname, 'staging', projectId);
    if (fs.existsSync(stagingDir)) await execAsync(`rm -rf ${stagingDir}`);

    res.json({ message: `Project ${projectId} has been completely eradicated from the server.` });
  } catch (error) {
    console.error('Teardown Error:', error.message);
    res.status(500).json({ error: 'Failed to destroy project infrastructure.' });
  }
});

// --- DATABASE TEARDOWN PROTOCOL ---
app.post('/api/db/destroy', requireAuth, (req, res) => {
  const { containerName } = req.body;
  
  if (!containerName) {
    return res.status(400).json({ error: 'Missing containerName parameter.' });
  }

  // 1. Strict Sanitization (Prevents Command Injection)
  if (!/^[a-zA-Z0-9_-]+$/.test(containerName)) {
    return res.status(400).json({ error: 'Invalid container name format.' });
  }

  console.log(`[TEARDOWN] Eradicating database container: ${containerName}`);
  
  // 2. The Kill Order (Force stop, remove container, and remove associated anonymous volumes)
  const destroyCmd = `docker rm -f -v ${containerName}`;

  exec(destroyCmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`[TEARDOWN ERROR]:`, stderr);
      // We return 200 if the container doesn't exist (already dead)
      if (stderr.includes('No such container')) {
        return res.status(200).json({ message: `Ghost resource cleared: ${containerName} was already destroyed.` });
      }
      return res.status(500).json({ error: 'Failed to eradicate database.', details: stderr });
    }
    
    console.log(`[TEARDOWN SUCCESS] ${containerName} eradicated.`);
    res.status(200).json({ message: `Database ${containerName} permanently eradicated.` });
  });
});



const PORT = 4000;
app.listen(PORT, () => console.log('🛡️  Monolith Receiver listening on port ' + PORT));