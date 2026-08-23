#!/usr/bin/env node
require('dotenv').config({ path: __dirname + '/.env' });
const PLATFORM_URL = 'http://20.2.198.46:4000';
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

// Masked terminal input for passwords/PATs
const askHidden = (query) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.stdoutMuted = true;
  rl.query = query;
  rl.question(rl.query, (val) => { rl.close(); resolve(val); });
  rl._writeToOutput = function (s) {
    if (rl.stdoutMuted) rl.output.write("\x1B[2K\x1B[200D" + rl.query + "*".repeat(rl.line.length));
    else rl.output.write(s);
  };
});

// --- GLOBAL AUTH RESOLVER ---
const getGlobalAuth = () => {
  const globalAuthPath = path.join(os.homedir(), '.monolith', 'auth.json');
  if (fs.existsSync(globalAuthPath)) {
    return JSON.parse(fs.readFileSync(globalAuthPath, 'utf8'));
  }
  return { token: process.env.MONOLITH_TOKEN, dashboardUrl: process.env.DASHBOARD_URL };
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
  .command('env:set <keyValue>')
  .description('Set an environment variable (e.g., monolith env set API_KEY=123)')
  .action(async (keyValue) => {

    
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("❌ Run 'monolith init' first.");
    
    const projectId = JSON.parse(fs.readFileSync(configPath)).id;
    const [key, ...valueParts] = keyValue.split('=');
    const value = valueParts.join('='); // In case the value itself has an '=' sign

    try {
      const spinner = ora('Updating secure vault...').start();
      const response = await axios.post(`${PLATFORM_URL}/api/env`, {
        projectId: projectId,
        envs: { [key]: value }
      });
      spinner.succeed('✅ ENV variable was set successfully\n');
      console.log(`✅ ${response.data.message}`);
    } catch (error) {
      spinner.fail("❌ Failed to secure variable: " + (error.response?.data?.error || error.message));
      console.log('\n\x1b[33m💡 Need help? Run `monolith guide` to view the platform architecture.\x1b[0m');
    }
  });

program
  .command('db:create <dbName>')
  .description('Provision a new Postgres database (e.g., monolith db create study_db)')
  .action(async (dbName) => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) return console.error("❌ Run 'monolith init' first.");
    const projectId = JSON.parse(fs.readFileSync(configPath)).id;

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

    console.log(`\nForging ${dbType.toUpperCase()} database '${dbName}' on the server...`);
    const spinner = ora(`Provisioning ${dbType} database (this takes a few seconds)...`).start();
        let dbUrl = '';
        let envKey = dbType === 'redis' ? 'REDIS_URL' : (dbType === 'mongodb' ? 'MONGO_URI' : 'DATABASE_URL');

        // --- STEP 1: PROVISION THE DATABASE ---
        try {
          const response = await axios.post(`${PLATFORM_URL}/api/db`, { dbName, dbType });
          dbUrl = response.data.databaseUrl;
          
          // UPDATE SPINNER TEXT WITHOUT STOPPING IT
          spinner.text = `Engine online. Auto-linking to server vault as ${envKey}...`;
        } catch (error) {
          if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            spinner.fail('Can\'t reach the Monolith server — is it running? (Connection Refused)');
          } else {
            spinner.fail("Failed to create database: " + (error.response?.data?.error || error.message));
          }
          return; // Stop completely if DB creation fails
        }

        // --- STEP 2: AUTO-LINK TO VAULT ---
        try {
          await axios.post(`${PLATFORM_URL}/api/env`, {
            projectId: projectId,
            envs: { [envKey]: dbUrl }
          });

          // STOP SPINNER WITH TOTAL SUCCESS
          spinner.succeed(`Database created and linked to vault successfully!`);
          console.log(`\n🔗 Connection String: \x1b[36m${dbUrl}\x1b[0m`);
        } catch (error) {
          // STOP SPINNER WITH A WARNING (Partial Success)
          spinner.warn(`Database was created, but auto-linking failed.`);
          console.log(`\n🔗 Your Connection String is: \x1b[36m${dbUrl}\x1b[0m`);
          console.log(`⚠️ Please link it manually by running: monolith env:set ${envKey} "<url>"`);
        }
  });

program
  .command('db:destroy <containerName>')
  .description('Permanently delete a database and its data')
  .action(async (containerName) => {
    console.log(`\n⚠️  WARNING: You are about to permanently eradicate '${containerName}'.`);
    console.log('This data CANNOT be recovered.');
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(`Type the container name to confirm: `, resolve));
    rl.close();

    if (answer !== containerName) {
      console.log('\n❌ Aborted. Container name did not match.'); process.exit(0);
    }

    const spinner = ora(`Destroying database ${containerName}...`).start();
    try {
      axios.defaults.headers.common['x-api-key'] = process.env.PLATFORM_API_KEY;
      const res = await axios.post(`${PLATFORM_URL}/api/db/destroy`, { containerName });
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
    
    // --- DATABASE SYNC PROTOCOL ---
    const auth = getGlobalAuth();
    const DASHBOARD_URL = auth.dashboardUrl || 'http://localhost:3000';
    const cliToken = auth.token;

    if (!cliToken) {
      console.error('\n❌ FATAL: Operator unauthenticated.');
      console.error('Run: monolith login --token <your_token>');
      process.exit(1);
    }
    const syncSpinner = ora('Syncing with Control Plane...').start();
    try {
      await axios.post(`${DASHBOARD_URL}/api/cli/init`, {
        token: cliToken,
        projectId: projectId,
        projectName: projectName,
        buildDirectory: buildDir || '/'
      });
      syncSpinner.succeed('Project registered in Dashboard Matrix.');
    } catch (error) {
      syncSpinner.fail('Failed to sync with Dashboard.');
      console.error(error.response?.data?.error || error.message);
      process.exit(1); // Abort completely if database sync fails
    }
    // ------------------------------

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

    // --- FIX 4: Check if project is GitHub connected ---
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
    console.log('Packing local directory (excluding node_modules & .git)...');

    const zipPath = path.join(process.cwd(), `${config.id}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({zlib:{level:9}}); // Max compression

    output.on('close', async () => {
      console.log(`📦 Packed ${archive.pointer()} total bytes.`);
      console.log('🚀 Uploading payload to Azure Server...(this may take some time)');
      
      const form = new FormData();
      form.append('projectId', config.id);
      form.append('payload', fs.createReadStream(zipPath));

      try {
        const res = await axios.post(`${PLATFORM_URL}/api/deploy`, form, {
          headers: { ...form.getHeaders() }
        });
        console.log('\n' + res.data.message); 
      } catch (err) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    console.error('\n❌ Can\'t reach the Monolith server — is it running? (Connection Refused)');
  } else {
    console.error('\n❌ Command failed:', err.response?.data?.error || err.message);
  }
}finally {
        // Always clean up the local zip file
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); 
      }
    });

    archive.on('error', (err) => { throw err; });
    archive.pipe(output);

    // --- THE FIX: Smart Payload Targeting ---
        const monolithConfigPath = path.join(process.cwd(), 'monolith.json');
        let targetDir = '';
        
        if (fs.existsSync(monolithConfigPath)) {
          const mConfig = JSON.parse(fs.readFileSync(monolithConfigPath, 'utf8'));
          targetDir = mConfig.buildDirectory || '';
        }

        if (targetDir && targetDir !== '') {
          // If a specific build directory exists, ONLY pack that folder and the config
          archive.glob('**/*', {
            cwd: path.join(process.cwd(), targetDir),
            ignore: ['**/node_modules/**', '**/.git/**', '**/.env']
          }, { prefix: targetDir }); // Preserves the folder name in the zip
          
          archive.file(monolithConfigPath, { name: 'monolith.json' });
        } else {
          // If it's a root project, pack everything except standard bloat
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
      console.error("❌ No project found. Run 'monolith init ' first.");
      process.exit(1);
    }
    
    const projectConfig = JSON.parse(fs.readFileSync(configPath));
    const projectId = projectConfig.id;

    console.log(`\n🔗 LINKING GITHUB CI/CD FOR: ${projectConfig.name}`);
    
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

    try {
      console.log(`\n⚙️  Forging webhook connection to ${repo.trim()}...`);
      
      const webhookUrl = `${PLATFORM_URL}/api/webhook?projectId=${projectId}`;
      
      // Using GitHub's official REST API to inject the webhook
      const response = await axios.post(
        `https://api.github.com/repos/${repo.trim()}/hooks`,
        {
          name: 'web',
          active: true,
          events: ['push'],
          config: {
            url: webhookUrl,
            content_type: 'json',
            secret: process.env.GITHUB_WEBHOOK_SECRET
          }
        },
        {
          headers: {
            'Authorization': `token ${token.trim()}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      console.log(`\n✅ CI/CD PIPELINE ESTABLISHED!`);
      console.log(`   Webhook injected successfully. Every 'git push' will now trigger an automatic deployment.`);
      console.log(`📜 To see logs after each git push run 'monolith logs'\n`);
      // Save the state so 'init' knows it's connected
      projectConfig.githubConnected = true;
      fs.writeFileSync(configPath, JSON.stringify(projectConfig, null, 2));
    } catch (error) {
      console.error(`\n❌ Failed to connect GitHub CI/CD:`);
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
    const configDir = path.join(process.cwd(), '.monolith');
    const configFile = path.join(configDir, 'project.json');

    if (!fs.existsSync(configFile)) {
      console.error("\n❌ Not a Monolith project. Run 'monolith init' first.");
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configFile));
    console.log('\n⏪ INITIATING INSTANT ROLLBACK...');

    try {
      const res = await axios.post(`${PLATFORM_URL}/api/rollback`, { projectId: config.id });
      console.log('\n✅ ' + res.data.message);
      console.log(`🌐 Live at: http://${res.data.domain}`);
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        console.error('\n❌ Can\'t reach the Monolith server.');
      } else {
        console.error('\n❌ Rollback failed:', err.response?.data?.error || err.message);
      }
    }
  });

program
  .command('list')
  .description('View all active deployments and databases on the server')
  .action(async () => {
    console.log('\n📡 Scanning Azure infrastructure...');
    try {
      axios.defaults.headers.common['x-api-key'] = process.env.PLATFORM_API_KEY;
      const res = await axios.get(`${PLATFORM_URL}/api/list`);

      if (res.data.apps.length > 0) {
        console.log('\n⬛ ACTIVE APPLICATIONS');
        console.table(res.data.apps);
      } else { console.log('\n⬛ ACTIVE APPLICATIONS: None'); }

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
  .description('Permanently delete the current project from the server')
  .action(async (targetId) => {
    let projectId = targetId;
    let configDir = null;

    // If no ID was provided in the command, try to read the local config
    if (!projectId) {
      configDir = path.join(process.cwd(), '.monolith');
      const configFile = path.join(configDir, 'project.json');
      if (!fs.existsSync(configFile)) {
         console.error("\n❌ No targetId provided, and not inside a Monolith project folder.");
         console.error("Usage: monolith destroy ");
         process.exit(1);
      }
      projectId = JSON.parse(fs.readFileSync(configFile)).id;
    }
    
    console.log(`\n⚠️  WARNING: You are about to permanently eradicate project '${projectId}'.`);
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(`Type the project ID to confirm: `, resolve));
    rl.close();

    if (answer !== projectId) {
       console.log('\n❌ Aborted.'); process.exit(0);
    }

    const spinner = ora('Eradicating project from Azure...').start();
    try {
      axios.defaults.headers.common['x-api-key'] = process.env.PLATFORM_API_KEY;
      const res = await axios.post(`${PLATFORM_URL}/api/destroy`, { projectId });
      spinner.succeed('🗑️  ' + res.data.message);
      
      if (configDir && fs.existsSync(configDir)) {
         fs.rmSync(configDir, { recursive: true, force: true });
         console.log('🧹 Local .monolith config removed.');
      }
    } catch (err) {
      spinner.fail('Teardown failed: ' + (err.response?.data?.error || err.message));
    }
  });

program
  .command('guide')
  .description('Display the Monolith quick-start guide and architecture flow')
  .action(() => {
    // --- Color helpers (raw ANSI, no extra deps needed) ---
    const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
    const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
    const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
    const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
    const green  = (s) => `\x1b[32m${s}\x1b[0m`;
    const gray   = (s) => `\x1b[90m${s}\x1b[0m`;
    const red    = (s) => `\x1b[31m${s}\x1b[0m`;

    const WIDTH = 68;
    const rule = () => gray('─'.repeat(WIDTH));

    const asciiArt = `
███╗   ███╗ ██████╗ ███╗   ██╗ ██████╗ ██╗     ██╗████████╗██╗  ██╗
████╗ ████║██╔═══██╗████╗  ██║██╔═══██╗██║     ██║╚══██╔══╝██║  ██║
██╔████╔██║██║   ██║██╔██╗ ██║██║   ██║██║     ██║   ██║   ███████║
██║╚██╔╝██║██║   ██║██║╚██╗██║██║   ██║██║     ██║   ██║   ██╔══██║
██║ ╚═╝ ██║╚██████╔╝██║ ╚████║╚██████╔╝███████╗██║   ██║   ██║  ██║
╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝   ╚═╝   ╚═╝  ╚═╝
`;

    console.log(bold(asciiArt));
    console.log('  ' + bold('YOUR SERVER. NO MIDDLEMEN.') + '   ' + dim('v1.0.0'));
    console.log(rule());

    // ---------- PIPELINE ----------
    console.log('\n  ' + bold(yellow('⚡ THE PIPELINE')) + '\n');

    const circled = ['①', '②', '③', '④'];

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

    step(1, 'SETUP', null, 'monolith init <project-name>',
      'Detects your framework, injects build scripts, writes .gitignore');
    step(2, 'PROVISION', 'optional', 'monolith db:create <db-name>',
      'Spins up Postgres / MySQL / Mongo / Redis, auto-linked to your vault');
    step(3, 'SECRETS', 'optional', 'monolith env:set KEY=value',
      'Encrypts and stores an environment variable on the server');

    console.log(`  ${yellow(circled[3])}  ${bold('DEPLOY')}`);
    console.log(`      ${gray('├─')} ${green('Manual')}      ${cyan('$ monolith deploy')}`);
    console.log(`      ${gray('│')}                 ${gray('Pack & ship on demand, whenever you want')}`);
    console.log(`      ${gray('└─')} ${green('Automatic')}   ${cyan('$ monolith github:connect')}`);
    console.log(`      ${' '.repeat(17)}${gray('Deploys automatically on every `git push`')}`);

    console.log('\n' + rule());

    // ---------- COMMAND REFERENCE ----------
    console.log('\n  ' + bold(yellow('📖 COMMAND REFERENCE')));

    const CMD_COL = 40;
    const row = (cmd, desc) => {
      const padded = cmd.padEnd(CMD_COL, ' ');
      console.log(`  ${cyan(padded)}${gray(desc)}`);
    };
    const section = (title) => console.log('\n  ' + dim(title));

    section('SETUP');
    row('init <project-name>', 'Initialize a project in the current directory');

    section('INFRASTRUCTURE');
    row('db:create <db-name>', 'Provision a database, auto-link it to the vault');
    row('db:destroy <container-name>', 'Permanently delete a database');

    section('SECRETS');
    row('env:set KEY=value', 'Store an encrypted environment variable');

    section('DEPLOYMENT');
    row('deploy', 'Pack the current directory and ship it manually');
    row('github:connect', 'Wire up automatic deploy-on-push CI/CD');
    row('rollback', 'Instantly revert to the previous working deployment');

    section('OPERATIONS');
    row('list', 'View all active applications and databases');
    row('logs', 'Stream live application logs in real time');

    section('DESTRUCTIVE');
    console.log(`  ${red('destroy [project-id]'.padEnd(CMD_COL, ' '))}${gray('Permanently eradicate a project and its resources')}`);

    console.log('\n' + rule());
    console.log('\n  ' + bold(`Let's deploy your dream project.`) + '\n');
  });

program
  .command('logs')
  .description('Stream live application logs directly from the server')
  .action(async () => {
    const configDir = path.join(process.cwd(), '.monolith');
    const configFile = path.join(configDir, 'project.json');
    if (!fs.existsSync(configFile)) return console.error("\n❌ Not a Monolith project.");
    const config = JSON.parse(fs.readFileSync(configFile));

    console.log('\n📡 Connecting to live Docker stream... (Press Ctrl+C to exit)\n');
    
    try {
      const res = await axios({
        method: 'get',
        url: `${PLATFORM_URL}/api/logs/stream?projectId=${config.id}`,
        headers: { 'x-api-key': process.env.PLATFORM_API_KEY },
        responseType: 'stream' // Tell Axios to keep the connection open
      });

      res.data.on('data', chunk => process.stdout.write(chunk));
    } catch (err) {
      console.error('❌ Log stream failed.');
    }
  });

program.parse(process.argv);