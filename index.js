#!/usr/bin/env node
require('dotenv').config({ path: __dirname + '/.env' });
const ora = require('ora');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const {ZipArchive} = require('archiver');   // ✅ require works
const path = require('path');
const { program } = require('commander');
const readline = require('readline');
const crypto = require('crypto');
const os = require('os');

axios.defaults.timeout = 300000; // 5-minute timeout for heavy deployments

// --- SECURITY FIX: Attach the API Key to every request ---
axios.defaults.headers.common['x-api-key'] = process.env.PLATFORM_API_KEY;

function isValidIdentifier(s) { return typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s); }

// Stealth terminal input for passwords/PATs (Handles clipboard pastes perfectly)
const askHidden = (query) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  let promptWritten = false;
  
  rl._writeToOutput = function (s) {
    // 1. Allow the initial prompt to render normally
    if (!promptWritten) {
      rl.output.write(s);
      promptWritten = true;
      return;
    }
    
    // 2. Allow the Enter key to move to the next line
    if (s.includes('\n') || s.includes('\r')) {
      rl.output.write('\n');
      return;
    }
    
    // 3. Swallow all other keystrokes and pastes (Complete Silence)
  };
  
  rl.question(query, (val) => {
    rl.close();
    resolve(val);
  });
});

// --- GLOBAL AUTH RESOLVER ---
const getGlobalAuth = () => {
  const globalAuthPath = path.join(os.homedir(), '.monolith', 'auth.json');
  if (fs.existsSync(globalAuthPath)) {
    return JSON.parse(fs.readFileSync(globalAuthPath, 'utf8'));
  }
  return { token: process.env.MONOLITH_TOKEN, dashboardUrl: process.env.DASHBOARD_URL };
};

// --- DYNAMIC TARGET RESOLVER ---
const resolveTarget = async (projectId) => {
  const auth = getGlobalAuth();
  if (!auth || !auth.token) {
    throw new Error("Unauthorized Operator. Run 'monolith login' first.");
  }
  const dashboardUrl = auth.dashboardUrl || 'http://localhost:3000';

  try {
    const res = await axios.post(`${dashboardUrl}/api/cli/target`, {
      token: auth.token,
      projectId: projectId
    });

    const { targetServer } = res.data;
    if (!targetServer) {
      throw new Error("Workload untethered. No target hardware assigned in the Matrix.");
    }

    return {
      url: `http://${targetServer.ipAddress}:4000`,
      apiKey: targetServer.apiKey
    };
  } catch (error) {
    throw new Error(error.response?.data?.error || "Failed to locate hardware coordinates.");
  }
};

program
  .name('monolith')
  .description('Monolith Infrastructure Command Line Interface')
  .version('1.0.0');

program
  .command('login')
  .description('Authenticate your CLI with the Monolith Control Plane')
  .requiredOption('-t, --token <string>', 'Your Personal Access Token')
  .option('-u, --url <string>', 'Your Dashboard URL', 'http://localhost:3000')
  .action((options) => {
    const globalDir = path.join(os.homedir(), '.monolith');
    if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });

    const authConfig = {
      token: options.token,
      dashboardUrl: options.url
    };

    fs.writeFileSync(
      path.join(globalDir, 'auth.json'),
      JSON.stringify(authConfig, null, 2),
      { mode: 0o600 } // Secure file permissions
    );

    console.log(`\n✅ Operator authenticated successfully.`);
    console.log(`📡 Connected to Control Plane at: ${options.url}`);
    console.log(`🔐 Credentials secured in ${globalDir}/auth.json\n`);
  });

program
  .command('env:set')
  .description('Interactively securely inject an environment variable into the remote vault')
  .action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("\n❌ Not a Monolith project. Run 'monolith init' first.");
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const activeProjectId = config.id || config.projectId;
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n🔒 [VAULT INJECTION PROTOCOL]');
    
    // Prompt 1: The Key
    readline.question('Enter the variable KEY (e.g., API_KEY): ', (rawKey) => {
      // Auto-format the key for safety (Uppercase + Underscores)
      const key = rawKey.trim().toUpperCase().replace(/\s+/g, '_');
      
      if (!key) {
        console.log('❌ Key cannot be empty. Aborting.');
        return readline.close();
      }

      // Prompt 2: The Value
      readline.question(`Enter the VALUE for [${key}]: `, async (value) => {
        readline.close();
        
        console.log(''); // Spacing
        const spinner = ora('Updating secure remote vault...').start();
        
        try {
          // 1. Acquire Target Coordinates
          const target = await resolveTarget(activeProjectId);
          
          // 2. Fire Payload (Azure node will append/merge this into the existing .env file)
          const response = await axios.post(`${target.url}/api/env`, {
            projectId: activeProjectId,
            envs: { [key]: value }
          }, {
            headers: { 'x-api-key': target.apiKey }
          });
          
          spinner.succeed(`✅ Secret [${key}] securely locked into the vault.`);
          console.log(`⚠️  SYSTEM NOTE: You must redeploy the application for the container to reflect this change.\n`);
        } catch (error) {
          spinner.fail("❌ Failed to secure variable: " + (error.response?.data?.error || error.message));
        }
      });
    });
  });

program
  .command('env:rm')
  .description('Tactically eradicate an environment variable from the remote vault')
  .action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("\n❌ Not a Monolith project.");
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const activeProjectId = config.id || config.projectId;

    console.log('\n📡 Interfacing with secure remote vault...');
    
    try {
      const target = await resolveTarget(activeProjectId);

      // 1. Fetch current contents of the vault
      const fetchRes = await axios.get(`${target.url}/api/env?projectId=${activeProjectId}`, {
        headers: { 'x-api-key': target.apiKey }
      });

      const envs = fetchRes.data.envs || {};
      const keys = Object.keys(envs);

      if (keys.length === 0) {
        return console.log('\n🛡️  Vault is currently empty. Nothing to delete.');
      }

      // 2. Display the tactical selector
      console.log('\n[ACTIVE VAULT VARIABLES]');
      keys.forEach((key, index) => {
        console.log(`[${index + 1}] ${key}`);
      });
      console.log(`[0] Cancel Operation\n`);

      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });

      // 3. Process the deletion
      readline.question('Select target key for eradication (number): ', async (answer) => {
        readline.close();
        
        const selection = parseInt(answer.trim(), 10);
        
        if (selection === 0 || isNaN(selection) || selection < 1 || selection > keys.length) {
          return console.log('\n🛑 Operation aborted.');
        }

        const targetKey = keys[selection - 1];
        console.log(`\n🔥 Initiating purge for ${targetKey}...`);

        await axios({
          method: 'delete',
          url: `${target.url}/api/env`,
          headers: { 'x-api-key': target.apiKey },
          data: { projectId: activeProjectId, envKey: targetKey }
        });

        console.log(`✅ Target [${targetKey}] successfully eradicated from Azure.`);
        console.log(`⚠️  SYSTEM NOTE: You must redeploy the application for the container to reflect this change.`);
      });

    } catch (err) {
      console.error('\n❌ Vault access failed:', err.response?.data?.error || err.message);
    }
  }); 

program
  .command('db:migrate')
  .description('Migrate data from an external provider to an attached Monolith database')
  .action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) {
      console.error("❌ Run 'monolith init' first to establish target context.");
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const activeProjectId = config.id || config.projectId;

    console.log('\n🛸 --- MONOLITH EPHEMERAL MIGRATION ENGINE --- 🛸\n');
    const detectSpinner = ora('Detecting attached databases on execution node...').start();

    let target;
    try {
      target = await resolveTarget(activeProjectId);
      const listRes = await axios.get(`${target.url}/api/list?projectId=${activeProjectId}`, {
        headers: { 'x-api-key': target.apiKey }
      });

      const dbs = listRes.data.dbs || [];
      if (dbs.length === 0) {
        detectSpinner.fail('No databases detected for this project.');
        console.log("Run 'monolith db:create <dbName>' before initiating migration.\n");
        process.exit(1);
      }

      detectSpinner.succeed(`Found ${dbs.length} attached database(s).`);

      console.log('\n⬛ SELECT TARGET DATABASE');
      dbs.forEach((db, idx) => {
        console.log(`[${idx + 1}] ${db.name} (${db.type || 'postgres'}) - Status: ${db.status}`);
      });

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (query) => new Promise((resolve) => rl.question(query, resolve));

      const selection = await ask('\nSelect destination database number: ');
      const dbIndex = parseInt(selection.trim(), 10) - 1;

      if (isNaN(dbIndex) || !dbs[dbIndex]) {
        rl.close();
        console.log('❌ Invalid selection. Migration aborted.');
        process.exit(1);
      }

      const chosenDb = dbs[dbIndex];
      const dbType = (chosenDb.type || 'postgres').toLowerCase();
      rl.close();

      console.log(`\nSelected target: ${chosenDb.name} [${dbType.toUpperCase()}]`);
      console.log('[SECURITY] Inputs are masked. Bypassed from shell history.');
      
      const sourceUrl = await askHidden('Source Database Connection URI (Supabase/Atlas): ');
      console.log('');
      const targetUrl = await askHidden('Target Monolith Connection URI (from db:create): ');
      console.log('');

      if (!sourceUrl.trim() || !targetUrl.trim()) {
        console.log('❌ Migration aborted: Both Source and Target URIs are required.');
        process.exit(1);
      }

      const migrateSpinner = ora('Transmitting migration payload to Ephemeral Worker...').start();

      const res = await axios.post(`${target.url}/api/db/migrate`, {
        projectId: activeProjectId,
        dbType: dbType,
        sourceUrl: sourceUrl.trim(),
        targetUrl: targetUrl.trim()
      }, {
        headers: { 'x-api-key': target.apiKey }
      });

      if (!sourceUrl.trim() || !targetUrl.trim()) {
        console.log('❌ Migration aborted: Both Source and Target URIs are required.');
        process.exit(1);
      }

      // --- SUPABASE PRE-FLIGHT INTERCEPTOR ---
      if (sourceUrl.includes('supabase.co') && !sourceUrl.includes('pooler.supabase.com')) {
        console.log('\n⚠️  [SUPABASE CONFIGURATION DETECTED]');
        console.log('You pasted a direct Supabase IPv6 URL. Cloud providers require IPv4 for migrations.');
        console.log('\n[TECHNICAL DIRECTIVE]:');
        console.log('1. Go to your Supabase Dashboard -> Database -> Connection Pooler.');
        console.log('2. Copy the IPv4 Pooler URL (e.g., aws-1...pooler.supabase.com).');
        console.log('3. Change the port in that URL from 6543 to 5432.');
        console.log('\nFor a detailed architectural breakdown, run: monolith guide\n');
        process.exit(1);
      }
      // ---------------------------------------

      migrateSpinner.succeed(`✅ ${res.data.message}`);
      // --- NEW: AUTO-ATTACH TELEMETRY STREAM ---
      console.log(`\n📡 Tapping into live ephemeral worker telemetry... (Press Ctrl+C to disconnect)\n`);
      
      const streamRes = await axios({
        method: 'get',
        url: `${target.url}/api/logs/stream?projectId=${activeProjectId}&type=migration`,
        headers: { 'x-api-key': target.apiKey },
        responseType: 'stream'
      });

      streamRes.data.on('data', chunk => process.stdout.write(chunk));
      // ----------------------------------------

    } catch (err) {
      if (detectSpinner.isSpinning) detectSpinner.stop();
      // Use .fail() to permanently halt the spinner and display the error
      ora().fail(`❌ Migration initiation failed: ${err.response?.data?.error || err.message}`);
      process.exit(1);
    }
  });

program
  .command('db:create <dbName>')
  .description('Provision a new database (e.g., monolith db:create study_db)')
  .action(async (dbName) => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("❌ Run 'monolith init' first.");
    const config = JSON.parse(fs.readFileSync(configPath));
    const activeProjectId = config.id || config.projectId;

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    console.log(`\n⬛ DATABASE ENGINE SELECTION`);
    console.log(`1. PostgreSQL (Default)`);
    console.log(`2. MySQL`);
    console.log(`3. Redis`);
    console.log(`4. MongoDB`);
    
    let choice = await askQuestion('\nSelect engine (1-4, press Enter for 1): ');
    rl.close();

    const engines = { '1': 'postgres', '2': 'mysql', '3': 'redis', '4': 'mongodb' };
    const dbType = engines[choice.trim()] || 'postgres';

    console.log(`\nForging ${dbType.toUpperCase()} database '${dbName}'...`);
    const spinner = ora(`Acquiring target hardware...`).start();
    
    let target;
    try {
       target = await resolveTarget(activeProjectId);
       spinner.text = `Provisioning ${dbType} database on ${target.url}...`;
    } catch (error) {
       spinner.fail(error.message);
       return;
    }

    // Declare state variables outside the try/catch blocks so they survive the whole function
    let dbUrl = '';
    let actualContainerName = ''; 
    let envKey = dbType === 'redis' ? 'REDIS_URL' : (dbType === 'mongodb' ? 'MONGO_URI' : 'DATABASE_URL');

    // --- PROVISION THE DATABASE ---
    try {
      // 🎯 We are now injecting the activeProjectId into the payload
      const response = await axios.post(`${target.url}/api/db`, { 
        projectId: activeProjectId, 
        dbName, 
        dbType 
      }, {
        headers: { 'x-api-key': target.apiKey }
      });
      
      dbUrl = response.data.databaseUrl;
      actualContainerName = response.data.containerName; // Save the physical name here
      
      spinner.text = `Engine online. Auto-linking to server vault as ${envKey}...`;
    } catch (error) {
      spinner.fail("Failed to create database: " + (error.response?.data?.error || error.message));
      return;
    }

    // --- AUTO-LINK TO VAULT ---
    try {
      await axios.post(`${target.url}/api/env`, {
        projectId: activeProjectId,
        envs: { [envKey]: dbUrl }
      }, {
        headers: { 'x-api-key': target.apiKey }
      });

      spinner.succeed(`Database Engine Online`);
      
      // Output the exact physical name and variables we saved earlier
      console.log(`\n⬛ TARGET COORDINATES:`);
      console.log(`🗄️  Container Name:  ${actualContainerName}`); 
      console.log(`🗄️  Container URL:  ${dbUrl}   (save this in your .env for future purposes)`); 
      console.log(`🔗 Secure Vault:    ${envKey} auto-injected`);
      console.log(`\n(Keep this container name handy if you ever need to run 'monolith db:destroy')\n`);

    } catch (error) {
      spinner.warn(`Database was created, but auto-linking failed.`);
      console.log(`\n🔗 Your Connection String is: \x1b[36m${dbUrl}\x1b[0m`);
      console.log(`⚠️ Please link it manually by running: monolith env:set ${envKey}="<url>"`);
    }
  });

program
  .command('db:destroy <containerName>')
  .description('Permanently delete a database and its data')
  .action(async (containerName) => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("❌ Run 'monolith init' first to establish target context.");
    
    const config = JSON.parse(fs.readFileSync(configPath));
    const activeProjectId = config.id || config.projectId;

    console.log(`\n⚠️  WARNING: You are about to permanently eradicate '${containerName}'.`);
    console.log('This data CANAMPOT be recovered.');
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(`Type the container name to confirm: `, resolve));
    rl.close();

    if (answer !== containerName) {
      console.log('\n❌ Aborted. Container name did not match.'); process.exit(0);
    }

    const spinner = ora(`Acquiring target & destroying database ${containerName}...`).start();
    try {
      const target = await resolveTarget(activeProjectId);
      const res = await axios.post(`${target.url}/api/db/destroy`, { containerName }, {
        headers: { 'x-api-key': target.apiKey }
      });
      spinner.succeed('🗑️  ' + res.data.message);
    } catch (err) {
      spinner.fail('Teardown failed: ' + (err.response?.data?.error || err.message));
    }
  });

program
  .command('init')
  .description('Initialize a new Monolith project in the current directory')
  .argument('<projectName>', 'name of the project')
  .action(async (projectName) => {

    if (!isValidIdentifier(projectName)) {
      console.error("\n❌ Invalid project name. Use only letters, numbers, dashes, and underscores.");
      process.exit(1);
    }

    const configDir = path.join(process.cwd(), '.monolith');
    const configFile = path.join(configDir, 'project.json');

    if (fs.existsSync(configFile)) {
      const existingConfig = JSON.parse(fs.readFileSync(configFile));
      console.log(`\n⚠️  Project '\x1b[1m${existingConfig.name}\x1b[0m' is already initialized here.`);
      
      if (existingConfig.githubConnected) {
        console.log(`✅ CI/CD is active. Just run 'git push' to deploy.`);
      } else {
        console.log(`🚀 Next steps:`);
        console.log(`   - Run 'monolith deploy' for manual deployment.`);
        console.log(`   - Run 'monolith github connect' to automate CI/CD.`);
      }
      console.log(`\x1b[33m💡 Need help? Run \`monolith guide\` to view the platform architecture.\x1b[0m\n`);
      process.exit(0);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    // 1. Ask & Validate FIRST
    let buildDir = await askQuestion('📂 Enter your build directory (e.g., backend, api) or press Enter for root: ');
    buildDir = buildDir.trim();

    let targetPackageDir = process.cwd();

    if (buildDir !== '') {
      const checkPath = path.join(process.cwd(), buildDir);
      if (!fs.existsSync(checkPath)) {
        console.log(`\n❌ Directory '${buildDir}' not found. Initialization aborted.`);
        rl.close();
        process.exit(1); // Halt immediately
      }
      targetPackageDir = checkPath;
    }

    // 2. Only generate files if validation passed



    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    const projectId = `proj_${crypto.randomBytes(16).toString('hex')}`;
    const config = { name: projectName, id: projectId };
    
   // --- DATABASE SYNC & HARDWARE TETHER PROTOCOL ---
    const auth = getGlobalAuth();
    const DASHBOARD_URL = auth.dashboardUrl || 'http://localhost:3000';
    const cliToken = auth.token;

    if (!cliToken) {
      console.error('\n❌ FATAL: Operator unauthenticated.');
      console.error('Run: monolith login --token <your_token>');
      process.exit(1);
    }
    
    const syncSpinner = ora('Syncing with Control Plane to acquire hardware list...').start();
    let availableServers = [];

    try {
      // 1. Ask the Control Plane to initialize the project AND return the user's servers
      const res = await axios.post(`${DASHBOARD_URL}/api/cli/init`, {
        token: cliToken,
        projectId: projectId,
        projectName: projectName,
        buildDirectory: buildDir || '/'
      });
      availableServers = res.data.servers;
      syncSpinner.succeed('Project registered in Dashboard Matrix.');
    } catch (error) {
      syncSpinner.fail('Failed to sync with Dashboard.');
      console.error(error.response?.data?.error || error.message);
      process.exit(1); 
    }

    // 2. INTERACTIVE HARDWARE SELECTION
    if (!availableServers || availableServers.length === 0) {
       console.log('\n⚠️  WARNING: No BYOC nodes found in your account.');
       console.log('   The project is initialized, but you must attach a server via the Web Dashboard');
       console.log('   or run `monolith link` later before you can deploy.\n');
    } else {
       console.log("\n⬛ AVAILABLE EXECUTION NODES:");
       availableServers.forEach((s, index) => {
         console.log(`[${index + 1}] 🖥️  ${s.name} (${s.ipAddress})`);
       });

       let validSelection = false;
       while (!validSelection) {
         const answer = await askQuestion('\nSelect target hardware to tether this workload (number): ');
         const index = parseInt(answer.trim()) - 1;
         const selected = availableServers[index];

         if (!isNaN(index) && selected) {
           validSelection = true;
           const linkSpinner = ora(`Tethering workload to ${selected.name}...`).start();
           try {
             await axios.post(`${DASHBOARD_URL}/api/cli/link`, {
               token: cliToken,
               projectId: projectId,
               serverId: selected.id
             });
             linkSpinner.succeed(`✅ TETHER ESTABLISHED: Workload locked to [${selected.name}]`);
           } catch (error) {
             linkSpinner.fail('❌ Failed to tether hardware. You can link it later via the Dashboard.');
           }
         } else {
           console.log("❌ Invalid selection. Please enter a valid number.");
         }
       }
    }
    // ----------------------------------------------
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    
    // --- FIX 8: Auto-generate .gitignore to prevent secret leaks ---
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    const ignoreContent = "node_modules\n.env\n.env.local\n.monolith\n*.zip\n";
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, ignoreContent);
    } else {
      const existing = fs.readFileSync(gitignorePath, 'utf8');
      if (!existing.includes('.monolith')) {
      fs.appendFileSync(gitignorePath, `\n# Monolith PaaS\n${ignoreContent}`);
    }
  }

    console.log(`\n✅ Project initialized: ${projectName} (${projectId})`);

    if (buildDir !== '') {
      console.log(`📦 Generating monolith.json pointing to /${buildDir}...`);
      fs.writeFileSync(
        path.join(process.cwd(), 'monolith.json'), 
        JSON.stringify({ buildDirectory: buildDir }, null, 2)
      );
    } else {
      console.log(`📦 Using root directory for deployment.`);
    }

    // 3. Edge-Case Tool Registry & Interactive Fallback
    const packageJsonPath = path.join(targetPackageDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      
     // The Upgraded Registry: Now tracks if a tool needs specific folders during install
      const KNOWN_TOOLS = {
        '@prisma/client': { 
          name: 'Prisma ORM', 
          command: 'npx prisma generate',
          requiredFolder: 'prisma/' 
        },
        'patch-package': { 
          name: 'Patch Package', 
          command: 'patch-package',
          requiredFolder: 'patches/' 
        },
        'puppeteer': { 
          name: 'Puppeteer', 
          command: 'npx puppeteer browsers install',
          requiredFolder: null // Needs internet, not local files
        }
      };

      pkg.scripts = pkg.scripts || {};
      let currentPostInstall = pkg.scripts.postinstall ? pkg.scripts.postinstall.split(' && ') : [];
      let modified = false;

      let requiredFolders = [];

      for (const [dep, config] of Object.entries(KNOWN_TOOLS)) {
        if (allDeps[dep] && !currentPostInstall.includes(config.command)) {
          const answer = await askQuestion(`\n⚠️  Detected ${config.name}. Add '${config.command}' to build step? (Y/n): `);
          if (answer.toLowerCase() !== 'n') {
            currentPostInstall.push(config.command);
            modified = true;

            
             // Dynamically fix the Docker caching layer if the tool needs a local folder
            if (config.requiredFolder) {
              requiredFolders.push(`'${config.requiredFolder}'`);
            }
          
          }
        }
      }

      if(requiredFolders.length>0){
        const tomlPath = path.join(targetPackageDir, 'nixpacks.toml');
              if (!fs.existsSync(tomlPath)) {
                console.log(`   ⚙️  Auto-generating nixpacks.toml to optimize ${config.name} build caching...`);
                
                const nixpacksContent = `[phases.install]
cmds = ['npm install']
onlyIncludeFiles = ['package.json', 'package-lock.json', ${requiredFolders.join(', ')}]
`;
                fs.writeFileSync(tomlPath, nixpacksContent);
              }
      }

      const customCmd = await askQuestion(`\n⚙️  Any other custom build commands to run after install? (Leave blank for none): `);
      if (customCmd.trim() !== '') {
        currentPostInstall.push(customCmd.trim());
        modified = true;
      }

      if (modified) {
        pkg.scripts.postinstall = currentPostInstall.join(' && ');
        fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
        console.log(`\n✅ Build scripts successfully injected into package.json.`);
      }
    }
    
    rl.close();
  });

program
  .command('server:add')
  .description('Register a new BYOC Execution Node to your Monolith fleet')
  .action(async () => {
    const auth = getGlobalAuth();
    const dashboardUrl = auth.dashboardUrl || 'http://localhost:3000';
    
    if (!auth || !auth.token) {
      console.error("\n❌ FATAL: Operator unauthenticated. Run 'monolith login --token <your_token>' first.");
      process.exit(1);
    }

    console.log('\n⬛ EXECUTION NODE REGISTRATION');
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    const name = await askQuestion('Assign a tactical name (e.g., azure-prod-1): ');
    const ipAddress = await askQuestion('Enter the public IPv4 address: ');
    
    // Using the askHidden function already present in your CLI to mask the key
    const apiKey = await askHidden('Enter the x-api-key for this node (hidden): ');
    rl.close();

    if (!name.trim() || !ipAddress.trim() || !apiKey.trim()) {
      console.log('\n❌ Aborted: All coordinates are strictly required.');
      process.exit(1);
    }

    const spinner = ora('Forging connection to the Matrix...').start();
    
    try {
      const res = await axios.post(`${dashboardUrl}/api/cli/server/add`, {
        token: auth.token,
        name: name.trim(),
        ipAddress: ipAddress.trim(),
        apiKey: apiKey.trim()
      });
      
      spinner.succeed(`✅ ${res.data.message}`);
      console.log(`🖥️  Node [${name}] is now live and visible in your Web Dashboard.`);
    } catch (err) {
      spinner.fail('❌ Registration failed: ' + (err.response?.data?.error || err.message));
    }
  });

program
  .command('deploy')
  .description('Pack and deploy the current directory to the Monolith server')
  .action(async () => {
    const configDir = path.join(process.cwd(), '.monolith');
    const configFile = path.join(configDir, 'project.json');

    if (!fs.existsSync(configFile)) {
      console.error("\n❌ Not a Monolith project. Run 'monolith init' first.");
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configFile));

    if (config.githubConnected) {
      console.log('\n⚠️  WARNING: This project is connected to GitHub CI/CD.');
      console.log('Running a manual deploy will temporarily overwrite the automated pipeline state.');
      
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => rl.question('Are you sure you want to deploy manually? (y/N): ', resolve));
      rl.close();
      
      if (answer.toLowerCase() !== 'y') {
        console.log('Deployment cancelled. Run `git push` to deploy via CI/CD instead.');
        process.exit(0);
      }
    }

    console.log('\n⬛ MONOLITH DEPLOYMENT INITIATED');

    // --- DYNAMIC TARGET ACQUISITION ---
    const auth = getGlobalAuth();
    const dashboardUrl = auth.dashboardUrl || 'http://localhost:3000';
    const cliToken = auth.token;

    if (!cliToken) {
      console.error('\n❌ FATAL: Operator unauthenticated. Run: monolith login --token <your_token>');
      process.exit(1);
    }

    const targetSpinner = ora('Acquiring hardware coordinates from Control Plane...').start();
    let TARGET_URL = '';
    let TARGET_API_KEY = '';

    try {
      const res = await axios.post(`${dashboardUrl}/api/cli/target`, {
        token: cliToken,
        projectId: config.id
      });

      const { targetServer } = res.data;

      if (!targetServer) {
        targetSpinner.fail('❌ Workload is untethered. No target hardware assigned in the Matrix.');
        process.exit(1);
      }

      // Reconstruct the Execution Node URL assuming port 4000
      TARGET_URL = `http://${targetServer.ipAddress}:4000`;
      TARGET_API_KEY = targetServer.apiKey;

      targetSpinner.succeed(`Coordinates locked: ${targetServer.name} [${TARGET_URL}]`);
    } catch (error) {
      targetSpinner.fail('Failed to locate hardware coordinates.');
      console.error(error.response?.data?.error || error.message);
      process.exit(1);
    }
    // ---------------------------------------

    console.log('Packing local directory (excluding node_modules & .git)...');

    const zipPath = path.join(process.cwd(), `${config.id}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({zlib:{level:9}});

    output.on('close', async () => {
      console.log(`📦 Packed ${archive.pointer()} total bytes.`);
      console.log('🚀 Uploading payload to Execution Node...  This may take several minutes...');
      
      const form = new FormData();
      form.append('projectId', config.id);
      form.append('payload', fs.createReadStream(zipPath));

      try {
        // OVERRIDE: Fire payload to the dynamic TARGET_URL and inject the specific node's API Key
        const res = await axios.post(`${TARGET_URL}/api/deploy`, form, {
          headers: { 
            ...form.getHeaders(),
            'x-api-key': TARGET_API_KEY 
          }
        });
        console.log('\n' + res.data.message); 
      } catch (err) {
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
          console.error(`\n❌ Can't reach the target node at ${TARGET_URL} — is it running?`);
        } else {
          console.error('\n❌ Command failed:', err.response?.data?.error || err.message);
        }
      } finally {
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); 
      }
    });

    archive.on('error', (err) => { throw err; });
    archive.pipe(output);

    const monolithConfigPath = path.join(process.cwd(), 'monolith.json');
    let targetDir = '';
    
    if (fs.existsSync(monolithConfigPath)) {
      const mConfig = JSON.parse(fs.readFileSync(monolithConfigPath, 'utf8'));
      targetDir = mConfig.buildDirectory || '';
    }

    if (targetDir && targetDir !== '') {
      archive.glob('**/*', {
        cwd: path.join(process.cwd(), targetDir),
        ignore: ['**/node_modules/**', '**/.git/**', '**/.env']
      }, { prefix: targetDir });
      
      archive.file(monolithConfigPath, { name: 'monolith.json' });
    } else {
      archive.glob('**/*', {
        cwd: process.cwd(),
        ignore: ['**/node_modules/**', '**/.git/**', '**/.env', '**/*.zip', '**/.monolith/**']
      });
    }
    
    archive.finalize();
  });

program
  .command('github:connect')
  .description('Automatically configure GitHub CI/CD webhooks for your repository')
  .action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) {
      console.error("❌ No project found. Run 'monolith init' first.");
      process.exit(1);
    }
    
    const projectConfig = JSON.parse(fs.readFileSync(configPath));
    const activeProjectId = projectConfig.id || projectConfig.projectId;

    console.log(`\n🔗 LINKING GITHUB CI/CD FOR: ${projectConfig.name || activeProjectId}`);
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    const repo = await askQuestion('\n📂 Enter your GitHub repository (format: username/repo): ');
    if (!repo.includes('/')) {
        console.error("❌ Invalid format. Must be 'username/repo'.");
        rl.close();
        process.exit(1);
    }

    console.log(`\n🔑 To automate this, we need a GitHub Personal Access Token (PAT).`);
    console.log(`   Generate one here: https://github.com/settings/tokens/new`);
    console.log(`   (Required permissions: 'repo' and 'admin:repo_hook')`);
    
    const token = await askHidden('Enter GitHub Personal Access Token (hidden): ');
    rl.close();

    const spinner = ora('Acquiring hardware coordinates & injecting webhook...').start();

    try {
      // 1. DYNAMIC TARGET ACQUISITION
      const target = await resolveTarget(activeProjectId);
      
      // 2. FORGE WEBHOOK URL FOR SPECIFIC NODE
      const webhookUrl = `${target.url}/api/webhook?projectId=${activeProjectId}`;
      
      await axios.post(
        `https://api.github.com/repos/${repo.trim()}/hooks`,
        {
          name: 'web',
          active: true,
          events: ['push'],
          config: {
            url: webhookUrl,
            content_type: 'json',
            secret: process.env.GITHUB_WEBHOOK_SECRET // Ensure this is locally available or passed
          }
        },
        {
          headers: {
            'Authorization': `token ${token.trim()}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      spinner.succeed(`✅ CI/CD PIPELINE ESTABLISHED!`);
      // --- NEW: SYNCHRONIZE WITH THE CONTROL PLANE ---
      const auth = getGlobalAuth();
      const dashboardUrl = auth.dashboardUrl || 'http://localhost:3000';
      
      try {
        await axios.post(`${dashboardUrl}/api/cli/projects/link-repo`, {
          projectId: activeProjectId,
          repoUrl: `https://github.com/${repo.trim()}.git`,
          token: auth.token
        });
        console.log(`   Web Dashboard synchronized with Git Origin.`);
      } catch (syncErr) {
        console.log(`   ⚠️ Webhook active, but failed to sync UI with Dashboard.`);
      }
      console.log(`   Webhook injected securely pointing to target node.`);
      console.log(`📜 To see logs after each git push run 'monolith logs'\n`);
      
      projectConfig.githubConnected = true;
      fs.writeFileSync(configPath, JSON.stringify(projectConfig, null, 2));
    } catch (error) {
      spinner.fail(`❌ Failed to connect GitHub CI/CD:`);
      console.error(error.response?.data?.message || error.message);
      if (error.response?.status === 404) {
        console.error(`   (Hint: Check if the repository name is correct and your token has the right permissions.)`);
      }
    }
  });

program
  .command('rollback')
  .description('Instantly revert to the previous working deployment')
  .action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("\n❌ Not a Monolith project. Run 'monolith init' first.");

    const config = JSON.parse(fs.readFileSync(configPath));
    const activeProjectId = config.id || config.projectId;
    
    console.log('\n⏪ INITIATING INSTANT ROLLBACK...');

    try {
      const target = await resolveTarget(activeProjectId);
      const res = await axios.post(`${target.url}/api/rollback`, { projectId: activeProjectId }, {
        headers: { 'x-api-key': target.apiKey }
      });
      
      console.log('\n✅ ' + res.data.message);
      console.log(`🌐 Live at: http://${res.data.domain}`);
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        console.error('\n❌ Can\'t reach the target node.');
      } else {
        console.error('\n❌ Rollback failed:', err.response?.data?.error || err.message);
      }
    }
  });

program
  .command('list')
  .description('View all active deployments and databases on the target server')
  .action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("\n❌ Run 'monolith init' or 'monolith link' first to establish a hardware context.");
    
    const config = JSON.parse(fs.readFileSync(configPath));
    const activeProjectId = config.id || config.projectId;

    console.log('\n📡 Scanning local context hardware...');
    try {
      const target = await resolveTarget(activeProjectId);
      console.log(`🔗 Scanning target node at ${target.url}...\n`);

      const res = await axios.get(`${target.url}/api/list`, {
        headers: { 'x-api-key': target.apiKey }
      });

      if (res.data.apps.length > 0) {
        console.log('⬛ ACTIVE APPLICATIONS');
        console.table(res.data.apps);
      } else { console.log('⬛ ACTIVE APPLICATIONS: None'); }

      if (res.data.dbs.length > 0) {
        console.log('\n🗄️  ACTIVE DATABASES');
        console.table(res.data.dbs);
      } else { console.log('\n🗄️  ACTIVE DATABASES: None'); }
    } catch (err) {
      console.error('\n❌ Failed to fetch status:', err.response?.data?.error || err.message);
    }
  });

program
  .command('destroy [targetId]')
  .description('Permanently delete a project from the target server')
  .action(async (targetId) => {
    let activeProjectId = targetId;
    let configDir = null;

    // If no ID was provided in the command, try to read the local config
    if (!activeProjectId) {
      configDir = path.join(process.cwd(), '.monolith');
      const configFile = path.join(configDir, 'project.json');
      
      if (!fs.existsSync(configFile)) {
         console.error("\n❌ No targetId provided, and not inside a Monolith project folder.");
         console.error("Usage: monolith destroy <projectId>");
         process.exit(1);
      }
      
      const config = JSON.parse(fs.readFileSync(configFile));
      // Support both 'id' and 'projectId' keys based on how it was initialized/linked
      activeProjectId = config.id || config.projectId; 
    }
    
    console.log(`\n⚠️  WARNING: You are about to permanently eradicate project '${activeProjectId}'.`);
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(`Type the project ID to confirm: `, resolve));
    rl.close();

    if (answer !== activeProjectId) {
       console.log('\n❌ Aborted.'); process.exit(0);
    }

    const spinner = ora('Acquiring hardware coordinates...').start();
    try {
      // 1. DYNAMIC TARGET ACQUISITION
      const target = await resolveTarget(activeProjectId);
      spinner.text = `Eradicating project from ${target.url}...`;
      
      // 2. TACTICAL STRIKE
      const res = await axios.post(`${target.url}/api/destroy`, { projectId: activeProjectId }, {
        headers: { 'x-api-key': target.apiKey }
      });
      
      spinner.succeed('🗑️  ' + res.data.message);
      
      // 3. LOCAL CLEANUP (Only if we ran it from inside the project folder)
      if (configDir && fs.existsSync(configDir)) {
         fs.rmSync(configDir, { recursive: true, force: true });
         console.log('🧹 Local .monolith config removed.');
      }
    } catch (err) {
      spinner.fail('Teardown failed: ' + (err.response?.data?.error || err.message));
    }
  });

program
  .command('app:purge [containerName]')
  .description('Surgically purge an application container without destroying the project or database')
  .action(async (containerName) => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    
    if (!fs.existsSync(configPath) && !containerName) {
      return console.error("❌ Run 'monolith init' first, or provide a specific container name.");
    }

    let activeProjectId = null;
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath));
      activeProjectId = config.id || config.projectId;
    }

    const targetNameMsg = containerName ? `container '${containerName}'` : `the active application for project '${activeProjectId}'`;
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(`\n⚠️  WARNING: You are about to purge ${targetNameMsg}.\nType 'yes' to confirm: `, resolve));
    rl.close();

    if (answer.toLowerCase() !== 'yes') {
      return console.log('❌ Aborted.');
    }

    const spinner = ora(`Transmitting purge order...`).start();
    
    try {
      if (!activeProjectId) throw new Error("Must be inside a project directory to route the command without a server URL.");
      
      const target = await resolveTarget(activeProjectId);
      
      // ALIGNED THE ENDPOINT TO /purge
      const res = await axios.post(`${target.url}/api/app/purge`, {
        projectId: activeProjectId,
        containerName 
      }, {
        headers: { 'x-api-key': target.apiKey }
      });

      spinner.succeed(`✅ ${res.data.message}`);
    } catch (err) {
      spinner.fail('❌ Purge order failed.');
      console.error(err.response?.data?.error || err.message);
    }
  });

program
  .command('link')
  .description('Tether current directory to a deployed Monolith workload')
  .action(async () => {
    // --- FIX: UNIFIED AUTH RESOLVER ---
    const auth = getGlobalAuth();
    const dashboardUrl = auth.dashboardUrl || 'http://localhost:3000';
    
    if (!auth || !auth.token) {
      console.log("\n❌ Unauthorized Operator. Run 'monolith login --token <token>' first.");
      process.exit(1);
    }
    
    const token = auth.token;
    
    // Initialize the tactical spinner
    const spinner = ora({
      text: '📡 Interfacing with Control Plane...',
      color: 'green'
    }).start();
    
    try {
      // --- FIX: DYNAMIC DASHBOARD URL ---
      const response = await fetch(`${dashboardUrl}/api/cli/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });

      if (!response.ok) {
        spinner.fail('❌ Authorization rejected by Control Plane.');
        process.exit(1);
      }

      const { projects } = await response.json();

      if (!projects || projects.length === 0) {
        spinner.warn('⚠️ No workloads found in the Matrix. Initialize one via the Web Dashboard first.');
        process.exit(0);
      }

      spinner.stop();
      console.log("\n⬛ AVAILABLE WORKLOADS:");
      projects.forEach((p, index) => {
        console.log(`[${index + 1}] ${p.name} -> 🖥️  ${p.serverName} (${p.serverIp})`);
      });

      // Interactive prompt
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question('\nTarget workload number to link: ', (answer) => {
        const index = parseInt(answer.trim()) - 1;
        const selected = projects[index];

        if (isNaN(index) || !selected) {
          console.log("\n❌ Invalid coordinates. Aborting sequence.");
          rl.close();
          process.exit(1);
        }

        // Establish the Local State
        const projectDir = path.join(process.cwd(), '.monolith');
        if (!fs.existsSync(projectDir)) {
          fs.mkdirSync(projectDir);
        }

        // --- ALIGNMENT: Save as 'id' to maintain parity with 'init' ---
        fs.writeFileSync(
          path.join(projectDir, 'project.json'), 
          JSON.stringify({ id: selected.id, name: selected.name }, null, 2)
        );

        console.log(`\n✅ TETHER ESTABLISHED: Local payload locked to [${selected.name}]`);
        rl.close();
      });

    } catch (error) {
      spinner.fail(`❌ Connection failure: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Perform a full diagnostic health check on the active project')
  .action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("\n❌ Not a Monolith project. Run 'monolith init' first.");
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const activeProjectId = config.id || config.projectId;

    console.log(`\n🔍 Initiating diagnostic scan for [${activeProjectId}]...`);
    
    try {
      const target = await resolveTarget(activeProjectId);
      console.log(`📡 Interfacing with Execution Node at ${target.url}\n`);

      // Fetch Application, Database, and Vault states in parallel
      const [listRes, historyRes, envRes] = await Promise.all([
        axios.get(`${target.url}/api/list?projectId=${activeProjectId}`, { headers: { 'x-api-key': target.apiKey } }),
        axios.get(`${target.url}/api/containers/history?projectId=${activeProjectId}`, { headers: { 'x-api-key': target.apiKey } }),
        axios.get(`${target.url}/api/env?projectId=${activeProjectId}`, { headers: { 'x-api-key': target.apiKey } })
      ]);

      const dbs = listRes.data.dbs || [];
      const history = historyRes.data.history || [];
      const envs = envRes.data.envs || {};
      const envKeys = Object.keys(envs);

      // Split containers into Active vs Sleeping (Rollbacks)
      const activeContainers = history.filter(c => c.status.toLowerCase().includes("up") || c.state === "running");
      const rollbackTargets = history.filter(c => c.status.toLowerCase().includes("exited") || c.state === "exited");

      // --- 1. WORKLOAD HEALTH ---
      console.log('📦 [ACTIVE WORKLOADS]');
      if (activeContainers.length === 0) {
        console.log('   ⚠️  OFFLINE: No running containers detected.');
      } else {
        activeContainers.forEach(c => {
          console.log(`   🟢 ${c.name}`);
          console.log(`      State:  ${c.state.toUpperCase()}`);
          console.log(`      Uptime: ${c.status}`);
        });
      }

      // --- 2. SECURE ENVIRONMENT VAULT ---
      console.log('\n🔒 [SECURE ENVIRONMENT VAULT]');
      if (envKeys.length === 0) {
        console.log('   ⚠️  Vault is empty. No environment variables injected.');
      } else {
        console.log(`   🛡️  ${envKeys.length} secret(s) secured in the remote vault:`);
        envKeys.forEach(key => {
          console.log(`   🔑 ${key}`);
        });
      }

      // --- 3. RETENTION ENGINE STATE ---
      console.log('\n⏪ [RETENTION ENGINE & ROLLBACKS]');
      if (rollbackTargets.length === 0) {
        console.log('   ⚠️  No historical snapshots available.');
      } else {
        console.log(`   🛡️  ${rollbackTargets.length} sleeping container(s) safely preserved in memory.`);
        console.log(`   🎯 Primary Rollback Target: ${rollbackTargets[0].name}`);
        console.log(`      Forged: ${new Date(rollbackTargets[0].timestamp).toLocaleString()}`);
      }

      // --- 4. DATABASE INFRASTRUCTURE ---
      console.log('\n🗄️  [ATTACHED DATABASES]');
      if (dbs.length === 0) {
        console.log('   ⚠️  No databases linked to this project.');
      } else {
        dbs.forEach(db => {
          const dbName = db.name || 'Unnamed DB';
          const dbStatus = db.status && db.status.includes('Up') ? '🟢 ONLINE' : '🔴 OFFLINE';
          console.log(`   ${dbStatus} | ${dbName}`);
          if (db.port) console.log(`               Port: ${db.port}`);
        });
      }

      console.log('\n✅ Diagnostic scan complete.\n');

    } catch (err) {
      console.error('\n❌ Status check failed:', err.response?.data?.error || err.message);
    }
  });

program
  .command('guide')
  .description('Interactive animated walkthrough: login flow, deployment pipeline, and per-command failure diagnostics')
  .action(async () => {
    // ================= COLOR + FX HELPERS (raw ANSI, zero new deps) =================
    const esc     = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
    const bold    = (s) => esc(1, s);
    const dim     = (s) => esc(2, s);
    const cyan    = (s) => esc(36, s);
    const yellow  = (s) => esc(33, s);
    const green   = (s) => esc(32, s);
    const gray    = (s) => esc(90, s);
    const red     = (s) => esc(31, s);
    const magenta = (s) => esc(35, s);
    const blue    = (s) => esc(94, s);
 
    const isTTY = Boolean(process.stdout.isTTY);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const WIDTH = 68;
    const rule = (color = gray) => color('─'.repeat(WIDTH));
 
    // Typewriter effect — degrades to instant print when piped/non-interactive
    async function typeLine(text, delay = 5) {
      if (!isTTY) { console.log(text); return; }
      for (const ch of text) { process.stdout.write(ch); await sleep(delay); }
      process.stdout.write('\n');
    }
 
    // ================= BOOT ANIMATION =================
    const asciiArt = [
      '███╗   ███╗ ██████╗ ███╗   ██╗ ██████╗ ██╗     ██╗████████╗██╗  ██╗',
      '████╗ ████║██╔═══██╗████╗  ██║██╔═══██╗██║     ██║╚══██╔══╝██║  ██║',
      '██╔████╔██║██║   ██║██╔██╗ ██║██║   ██║██║     ██║   ██║   ███████║',
      '██║╚██╔╝██║██║   ██║██║╚██╗██║██║   ██║██║     ██║   ██║   ██╔══██║',
      '██║ ╚═╝ ██║╚██████╔╝██║ ╚████║╚██████╔╝███████╗██║   ██║   ██║  ██║',
      '╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝   ╚═╝   ╚═╝  ╚═╝',
    ];
    const gradient = [cyan, cyan, blue, blue, magenta, magenta]; // vertical gradient
 
    console.log('');
    for (let i = 0; i < asciiArt.length; i++) {
      console.log(gradient[i](asciiArt[i]));
      if (isTTY) await sleep(30);
    }
    console.log('');
    await typeLine('  ' + bold('YOUR SERVER. NO MIDDLEMEN.') + '   ' + dim('v1.0.0'), 4);
    console.log(rule());
 
    const bootSpinner = ora({ text: dim('Compiling guide modules...'), color: 'cyan' }).start();
    await sleep(isTTY ? 450 : 0);
    bootSpinner.succeed(dim('Guide modules loaded.'));
 
    // ================= STEP 0: ACCOUNT + PAT (the part people always ask about) =================
    console.log('\n' + rule());
    console.log('\n  ' + bold(yellow('🔑 BEFORE YOU START — GET YOUR PERSONAL ACCESS TOKEN')) + '\n');
    const patSteps = [
      ['1.', 'Open your Monolith Web Dashboard in a browser and log in (or create an account).'],
      ['2.', 'Go to Account / Settings → Personal Access Tokens → Generate New Token.'],
      ['3.', 'Copy the token — this is your PAT. It is shown once, treat it like a password.'],
      ['4.', 'Back in this terminal, authenticate the CLI with it:'],
    ];
    for (const [n, text] of patSteps) {
      console.log(`  ${yellow(n)} ${text}`);
    }
    console.log(`\n      ${cyan('$ monolith login --token <YOUR_PAT> --url <YOUR_DASHBOARD_URL>')}`);
    console.log(`      ${gray("(--url defaults to http://localhost:3000 if you don't pass it)")}`);
    console.log(`\n  ${dim('Your PAT + dashboard URL are saved locally to')} ${cyan('~/.monolith/auth.json')} ${dim('(mode 0600).')}`);
    console.log(`  ${dim('Every other command reads that file automatically — you only log in once per machine.')}`);
 
    // ================= THE PIPELINE =================
    console.log('\n' + rule());
    console.log('\n  ' + bold(yellow('⚡ THE PIPELINE')) + '\n');
 
    const circled = ['①', '②', '③', '④', '⑤'];
    function step(i, title, tag, cmd, desc, isLast) {
      const label = tag ? `${title}  ${dim('(' + tag + ')')}` : title;
      console.log(`  ${yellow(circled[i - 1])}  ${bold(label)}`);
      console.log(`      ${cyan('$ ' + cmd)}`);
      console.log(`      ${gray(desc)}`);
      if (!isLast) {
        console.log(gray('      │'));
        console.log(gray('      ▼'));
      }
    }
 
    step(1, 'REGISTER HARDWARE', 'once per server', 'monolith server:add',
      'Tells Monolith about a server you own — name, public IP, and its agent key');
    step(2, 'SETUP', null, 'monolith init <project-name>',
      'Detects your framework, injects build scripts, tethers to one of your servers');
    step(3, 'PROVISION', 'optional', 'monolith db:create <db-name>',
      'Spins up Postgres / MySQL / Mongo / Redis, auto-linked to your vault');
    step(4, 'SECRETS', 'optional', 'monolith env:set',
      'Encrypts and stores an environment variable on the tethered server');
 
    console.log(`  ${yellow(circled[4])}  ${bold('DEPLOY')}`);
    console.log(`      ${gray('├─')} ${green('Manual')}      ${cyan('$ monolith deploy')}`);
    console.log(`      ${gray('│')}                 ${gray('Pack & ship on demand, whenever you want')}`);
    console.log(`      ${gray('└─')} ${green('Automatic')}   ${cyan('$ monolith github:connect')}`);
    console.log(`      ${' '.repeat(17)}${gray('Deploys automatically on every `git push`')}`);
 
    console.log('\n' + rule());
 
    // ================= COMMAND DATA (grounded in what the CLI actually does) =================
    const SECTIONS = [
      {
        title: 'ACCOUNT & AUTH',
        cmds: [
          {
            cmd: 'login', usage: 'monolith login --token <PAT> [--url <dashboardUrl>]',
            desc: 'Authenticates this machine with your Monolith account using the PAT from the web dashboard. Writes ~/.monolith/auth.json.',
            why: [
              "--token wasn't provided — it's a required flag, there's no interactive fallback for it.",
              'The PAT was pasted with extra whitespace or a trailing newline.',
              "--url points at the wrong dashboard (silently defaults to http://localhost:3000 if you omit it).",
              "No write permission to your home directory, so ~/.monolith/auth.json can't be created.",
            ],
          },
          {
            cmd: 'link', usage: 'monolith link',
            desc: 'Lists every project on your account and tethers the current folder to one of them, without re-running init.',
            why: [
              'Not logged in yet — auth.json is missing or empty. Run `monolith login` first.',
              'Dashboard is unreachable (network, firewall, or the dashboard process is down).',
              "Your account has zero projects yet — projects are created via `monolith init`, so there's nothing to list.",
              'You typed a selection number outside the printed range.',
            ],
          },
        ],
      },
      {
        title: 'INFRASTRUCTURE',
        cmds: [
          {
            cmd: 'server:add', usage: 'monolith server:add',
            desc: "Registers one of your own machines (BYOC node) by public IP and its agent's x-api-key, so projects can tether to it.",
            why: [
              'Not logged in — run `monolith login` first.',
              "The IP address isn't reachable from the Control Plane, or a firewall blocks the agent's port.",
              "The x-api-key doesn't match what the Monolith agent on that server expects.",
              'A node with that tactical name already exists on your account.',
            ],
          },
          {
            cmd: 'init', usage: 'monolith init <project-name>',
            desc: 'Creates a new project, registers it with the Control Plane, and lets you tether it to one of your BYOC servers.',
            why: [
              'Project name has characters outside [A-Za-z0-9_-] — spaces and slashes are rejected.',
              'A .monolith/project.json already exists in this folder from a previous init.',
              'Not logged in — the Control Plane sync fails immediately without a token.',
              'No servers registered yet: init still succeeds, but the project stays untethered until you attach hardware.',
              "If you entered a build directory, that folder doesn't actually exist relative to where you ran the command.",
            ],
          },
          {
            cmd: 'db:create', usage: 'monolith db:create <db-name>',
            desc: "Provisions Postgres / MySQL / Redis / MongoDB on the project's tethered server and auto-injects the connection string into the vault.",
            why: [
              'Project is untethered — no target server assigned, so there is nothing to provision on.',
              "The tethered server is offline, or Docker isn't running on it.",
              'A database with that name is already using the required port on that node.',
              'Provisioning succeeded but auto-linking to the vault failed — the connection string prints so you can add it manually with `env:set`.',
            ],
          },
          {
            cmd: 'db:destroy', usage: 'monolith db:destroy <container-name>',
            desc: 'Permanently deletes a database container and its data. Requires typing the exact container name to confirm.',
            why: [
              "The confirmation text you typed doesn't exactly match the container name — intentional, to prevent fat-fingered deletes.",
              "Container name doesn't exist on the tethered server (double-check with `monolith list`).",
              'The tethered server is unreachable.',
            ],
          },
        ],
      },
      {
        title: 'SECRETS',
        cmds: [
          {
            cmd: 'env:set', usage: 'monolith env:set',
            desc: 'Interactively encrypts and stores one KEY=VALUE pair in the remote vault on your tethered server.',
            why: [
              'Not run from inside a project folder — no .monolith/project.json found.',
              'The tethered server is unreachable.',
              "The value doesn't take effect until you redeploy — the running container won't pick it up automatically.",
            ],
          },
          {
            cmd: 'env:rm', usage: 'monolith env:rm',
            desc: 'Lists current vault keys and lets you pick one to delete.',
            why: [
              'Vault is empty — there is nothing to select.',
              'The tethered server is unreachable while fetching or deleting.',
            ],
          },
        ],
      },
      {
        title: 'DEPLOYMENT',
        cmds: [
          {
            cmd: 'deploy', usage: 'monolith deploy',
            desc: 'Zips the project directory, uploads it to the tethered server, and runs a health-checked blue/green traffic switch.',
            why: [
              'Project is untethered — no target hardware assigned.',
              'Target node is down or unreachable (ECONNREFUSED/ETIMEDOUT) — the agent may not be running on port 4000.',
              'Upload hits the 5-minute hard timeout on a very large payload or slow connection.',
              "Traffic never switches because the new container fails its health check — check `monolith logs` (runtime stream).",
              "If this project is GitHub-connected, manual deploy needs an explicit 'y' confirmation since it temporarily overrides CI/CD.",
            ],
          },
          {
            cmd: 'github:connect', usage: 'monolith github:connect',
            desc: 'Registers a push webhook on your GitHub repo pointing at the tethered node, so every `git push` triggers a deploy.',
            why: [
              "Repo wasn't entered in 'username/repo' format.",
              'GitHub PAT is missing the repo or admin:repo_hook scope, or the repo name is wrong — GitHub returns 404 either way.',
              "GITHUB_WEBHOOK_SECRET isn't set in the CLI's local .env — worth double-checking this is present before relying on the webhook.",
              "Webhook registers on GitHub but the Dashboard sync call fails separately — CI/CD still works, the dashboard just won't show the repo link.",
            ],
          },
          {
            cmd: 'rollback', usage: 'monolith rollback',
            desc: 'Instantly flips live traffic back to the previous container, no rebuild required.',
            why: [
              'No previous deployment exists yet to roll back to (this is your first-ever deploy).',
              'The tethered server is unreachable.',
            ],
          },
        ],
      },
      {
        title: 'OPERATIONS',
        cmds: [
          {
            cmd: 'list', usage: 'monolith list',
            desc: 'Quick table of active applications and databases on the tethered server.',
            why: [
              'Project is untethered, or .monolith/project.json is missing.',
              'The tethered server is unreachable.',
            ],
          },
          {
            cmd: 'status', usage: 'monolith status',
            desc: 'Full diagnostic: container health, secure vault contents, rollback targets, and database status, in one scan.',
            why: [
              'Project is untethered, or .monolith/project.json is missing.',
              'The tethered server is unreachable — any of the three parallel API calls can fail this.',
            ],
          },
          {
            cmd: 'logs', usage: 'monolith logs',
            desc: 'Streams either the Nixpacks build log or the live runtime container log from the tethered server.',
            why: [
              'The tethered server is unreachable, so the stream never opens.',
              "You picked the runtime stream but nothing has deployed successfully yet, so there's no running container to tail.",
            ],
          },
        ],
      },
      {
        title: 'DESTRUCTIVE',
        cmds: [
          {
            cmd: 'app:purge', usage: 'monolith app:purge [container-name]',
            desc: 'Removes just the application container, leaving the project and any databases untouched.',
            why: [
              "Typed anything other than exactly 'yes' at the confirmation prompt — treated as an abort by design.",
              'No container name given and not run from inside a project directory, so there is nothing to target.',
              'The tethered server is unreachable.',
            ],
          },
          {
            cmd: 'destroy', usage: 'monolith destroy [project-id]',
            desc: 'Permanently deletes a project and every resource attached to it from the tethered server.',
            why: [
              "Confirmation text didn't exactly match the project ID.",
              'No project-id given and not run from inside a project folder.',
              'The tethered server is unreachable.',
            ],
          },
        ],
      },
    ];
 
    // Flatten for numbered lookup
    const FLAT = [];
    SECTIONS.forEach((section) => section.cmds.forEach((c) => FLAT.push(c)));
    FLAT.forEach((c, i) => { c._n = i + 1; });
 
    // ================= MENU RENDERING =================
    function printMenu() {
      console.log('\n  ' + bold(yellow('📖 COMMAND REFERENCE')) + '   ' + dim('(type a number to expand)'));
      const CMD_COL = 34;
      SECTIONS.forEach((section) => {
        console.log('\n  ' + dim(section.title));
        section.cmds.forEach((c) => {
          const isDestructive = section.title === 'DESTRUCTIVE';
          const label = `[${c._n}] ${c.cmd}`.padEnd(CMD_COL, ' ');
          console.log(`  ${isDestructive ? red(label) : cyan(label)}${gray(c.desc.split('.')[0] + '.')}`);
        });
      });
      console.log('\n' + rule());
      console.log(`  ${gray('Type a')} ${bold('number')} ${gray('to expand a command  ·  ')}${bold('a')}${gray(' = expand all  ·  ')}${bold('m')}${gray(' = redraw menu  ·  ')}${bold('q')}${gray(' = quit guide')}`);
    }
 
    function printCard(c) {
      console.log('\n  ' + rule(cyan));
      console.log(`  ${bold(cyan('▶ ' + c.cmd))}`);
      console.log(`  ${gray('Usage:')}  ${cyan('$ ' + c.usage)}`);
      console.log(`  ${gray('What it does:')} ${c.desc}`);
      console.log(`\n  ${yellow('⚠ COMMON FAILURE REASONS')}`);
      c.why.forEach((reason) => {
        console.log(`    ${red('•')} ${gray(reason)}`);
      });
      console.log('  ' + rule(cyan));
    }
 
    printMenu();
 
    // ================= INTERACTIVE EXPANDER LOOP =================
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
 
    let browsing = true;
    while (browsing) {
      const raw = (await ask(`\n  ${bold('guide>')} `)).trim().toLowerCase();
 
      if (raw === 'q' || raw === 'quit' || raw === 'exit') {
        browsing = false;
        break;
      }
      if (raw === 'm' || raw === 'menu') {
        printMenu();
        continue;
      }
      if (raw === 'a' || raw === 'all') {
        FLAT.forEach(printCard);
        continue;
      }
      if (/^\d+$/.test(raw)) {
        const match = FLAT.find((c) => c._n === parseInt(raw, 10));
        if (match) { printCard(match); continue; }
        console.log(gray('  No command at that number. Type `m` to see the menu again.'));
        continue;
      }
      // fallback: fuzzy match by command name
      const byName = FLAT.find((c) => c.cmd.toLowerCase().includes(raw));
      if (raw && byName) { printCard(byName); continue; }
 
      console.log(gray("  Not recognized. Type a number, a command name, 'a', 'm', or 'q'."));
    }
    rl.close();
 
    console.log('\n' + rule());
    console.log('\n  ' + bold(`Let's deploy your dream project.`) + '\n');
  });

program
.command('logs')
.description('Stream live application logs directly from the server')
.action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("\n❌ Not a Monolith project.");
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const activeProjectId = config.id || config.projectId;

    // 1. Create a native terminal selector
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n[1] 🏗️  Build Stream (Nixpacks Compilation)');
    console.log('[2] 🟢 Runtime Stream (Live Docker Container)\n');
    
    readline.question('Select target stream (1 or 2): ', async (answer) => {
      readline.close();
      const type = answer.trim() === '1' ? 'build' : 'runtime';
      const typeLabel = type === 'build' ? 'BUILD' : 'RUNTIME';

      console.log('\n📡 Acquiring telemetry stream coordinates...');
      
      try {
        const target = await resolveTarget(activeProjectId);
        console.log(`🔗 Target locked. Streaming live ${typeLabel} logs from ${target.url}... (Press Ctrl+C to exit)\n`);

        // Send the type parameter to the Azure streaming engine
        const res = await axios({
          method: 'get',
          url: `${target.url}/api/logs/stream?projectId=${activeProjectId}&type=${type}`,
          headers: { 'x-api-key': target.apiKey },
          responseType: 'stream' 
        });

        res.data.on('data', chunk => process.stdout.write(chunk));
      } catch (err) {
        console.error('\n❌ Log stream failed:', err.message);
      }
    });
});

program.parse(process.argv);