#!/usr/bin/env node
require('dotenv').config({ path: __dirname + '/.env' });
const PLATFORM_URL = 'http://20.2.198.46:4000';
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const {ZipArchive} = require('archiver');   // ✅ require works
const path = require('path');
const { program } = require('commander');
const readline = require('readline');
const crypto = require('crypto');

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

program
  .name('monolith')
  .description('Monolith Infrastructure Command Line Interface')
  .version('1.0.0');

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
      const response = await axios.post(`${PLATFORM_URL}/api/env`, {
        projectId: projectId,
        envs: { [key]: value }
      });
      console.log(`✅ ${response.data.message}`);
    } catch (error) {
      console.error("❌ Failed to secure variable:", error.message);
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
    try {
      const response = await axios.post(`${PLATFORM_URL}/api/db`, { dbName, dbType });
      const dbUrl = response.data.databaseUrl;
      
      console.log(`✅ ${response.data.message}`);
      
      // --- NEW: AUTO-LINKING ENGINE ---
      const envKey = dbType === 'redis' ? 'REDIS_URL' : (dbType === 'mongodb' ? 'MONGO_URI' : 'DATABASE_URL');
      console.log(`🔗 Auto-linking to the server vault as \x1b[36m${envKey}\x1b[0m...`);
      
      await axios.post(`${PLATFORM_URL}/api/env`, {
        projectId: projectId,
        envs: { [envKey]: dbUrl }
      });

      console.log(`✅ Database linked successfully!`);
    } catch (error) {
      console.error("\n❌ Failed to create database:", error.response?.data?.error || error.message);
      console.log('\n\x1b[33m💡 Need help? Run `monolith guide` to view the platform architecture.\x1b[0m');
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

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
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
  .action(() => {
    console.log("\n⬛ MONOLITH DEPLOYMENT INITIATED");
    console.log("Packing local directory...");

    const outputFileName = 'monolith-build.zip';
    const outputPath = path.join(process.cwd(), outputFileName);
    const output = fs.createWriteStream(outputPath);
    
    // Initialize the compression engine
    const archive = new ZipArchive({
      zlib: { level: 9 } // Maximum tactical compression
    });

    // Listen for when the zipping is completely finished
    output.on('close', async () => {
  const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
  console.log(`[ SUCCESS ] Payload secured: ${outputFileName} (${sizeMB} MB)`);
  console.log("Initiating server transport...");

 try {
    // Read the project ID
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) {
      console.error("❌ No project found. Run 'monolith init ' first.");
      process.exit(1);
    }
    const projectConfig = JSON.parse(fs.readFileSync(configPath));

    const form = new FormData();
    form.append('payload', fs.createReadStream(outputPath));
    // Attach the ID to the transport
    form.append('projectId', projectConfig.id); 

    const response = await axios.post(`${PLATFORM_URL}/api/deploy`, form, {
      headers: { ...form.getHeaders() }
    });

    console.log(`\n✅ DEPLOYMENT SUCCESSFUL`);
    console.log(`Server Response: ${response.data.message}`);
    
    // Clean up the local zip file so we don't leave trash on the user's computer
    fs.unlinkSync(outputPath);

  } catch (error) {
    console.error(`\n❌ TRANSPORT FAILED`);
    console.error(error.response ? error.response.data : error.message);
    console.log('\n\x1b[33m💡 Need help? Run `monolith guide` to view the platform architecture.\x1b[0m');
  }finally {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
    }
});

    // Handle any catastrophic errors during compression
    archive.on('error', (err) => {
      console.error("[ ERROR ] Failed to pack code:", err);
      process.exit(1);
    });

    archive.pipe(output);

    // Grab everything in the folder, but ruthlessly ignore heavy cache directories
    archive.glob('**/*', {
      cwd: process.cwd(),
      ignore: ['node_modules/**', '.git/**', '.expo/**','.monolith/**','dist/**','.env', outputFileName]
    });

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
  .command('guide')
  .description('Display the Monolith quick-start guide and architecture flow')
  .action(() => {
    const asciiArt = `
███╗   ███╗ ██████╗ ███╗   ██╗ ██████╗ ██╗     ██╗████████╗██╗  ██╗
████╗ ████║██╔═══██╗████╗  ██║██╔═══██╗██║     ██║╚══██╔══╝██║  ██║
██╔████╔██║██║   ██║██╔██╗ ██║██║   ██║██║     ██║   ██║   ███████║
██║╚██╔╝██║██║   ██║██║╚██╗██║██║   ██║██║     ██║   ██║   ██╔══██║
██║ ╚═╝ ██║╚██████╔╝██║ ╚████║╚██████╔╝███████╗██║   ██║   ██║  ██║
╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝   ╚═╝   ╚═╝  ╚═╝
    `;
    
    console.log(`\x1b[1m${asciiArt}\x1b[0m`); // Prints in bold
    console.log(`\x1b[1mTHE BRUTALIST INFRASTRUCTURE ENGINE\x1b[0m\n`);
    
    console.log(`\x1b[33mSTEP 1: IGNITION\x1b[0m`);
    console.log(`  Run: \x1b[36mmonolith init <name of project>\x1b[0m`);
    console.log(`  Auto-detects your framework, monorepo structure, and injects build scripts.\n`);

    console.log(`\x1b[33mSTEP 2: PROVISIONING (Optional)\x1b[0m`);
    console.log(`  Run: \x1b[36mmonolith db:create <name of DB image>\x1b[0m`);
    console.log(`  Spins up an isolated PostgreSQL instance and returns your DATABASE_URL.\n`);

    console.log(`\x1b[33mSTEP 3: SECRETS VAULT (Optional)\x1b[0m`);
    console.log(`  Run: \x1b[36mmonolith env:set <name of variable>='<value of env variable>'\x1b[0m`);
    console.log(`  Injects environment variables directly into your server's secure vault.\n`);

    console.log(`\x1b[33mSTEP 4: DEPLOYMENT\x1b[0m`);
    console.log(`  \x1b[90mOption A (Manual):\x1b[0m Run \x1b[36mmonolith deploy\x1b[0m from your terminal.`);
    console.log(`  \x1b[90mOption B (Auto):\x1b[0m   Run \x1b[36mmonolith github:connect\x1b[0m to deploy on every 'git push'.\n`);
    
    console.log(`\x1b[1mYour PaaS is live and awaiting commands.\x1b[0m\n`);
  });

program
  .command('logs')
  .description('View the latest deployment logs for your project')
  .action(async () => {
    const configPath = path.join(process.cwd(), '.monolith', 'project.json');
    if (!fs.existsSync(configPath)) {
      console.error("❌ No project found. Run 'monolith init ' first.");
      return;
    }
    const projectId = JSON.parse(fs.readFileSync(configPath)).id;

    try {
      console.log(`\n📡 Fetching deployment logs for ${projectId}...\n`);
      const response = await axios.get(`${PLATFORM_URL}/api/logs?projectId=${projectId}`);
      console.log(response.data.logs);
    } catch (error) {
      console.error("❌ Failed to fetch logs:", error.response?.data?.error || error.message);
      console.log('\n\x1b[33m💡 Need help? Run `monolith guide` for troubleshooting.\x1b[0m');
    }
  });

program.parse(process.argv);