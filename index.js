#!/usr/bin/env node

const PLATFORM_URL = 'http://20.2.198.46:4000';
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const {ZipArchive} = require('archiver');   // ✅ require works
const path = require('path');
const { program } = require('commander');
const readline = require('readline');

program
  .name('monolith')
  .description('Monolith Infrastructure Command Line Interface')
  .version('1.0.0');

program
  .command('env set')
  .description('Set an environment variable (e.g., monolith env set API_KEY=123)')
  .argument('<keyValue>', 'MY_TEST_KEY')
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
    }
  });

program
  .command('db create')
  .description('Provision a new Postgres database (e.g., monolith db create study_db)')
  .argument('<dbName>', 'Name of the database created')
  .action(async (dbName) => {
    console.log(`Forging database '${dbName}' on the server...`);
    try {
      const response = await axios.post(`${PLATFORM_URL}/api/db`, {
        dbName: dbName
      });
      
      console.log(`✅ ${response.data.message}`);
      console.log(`\nDATABASE_URL:`);
      console.log(`\x1b[32m${response.data.databaseUrl}\x1b[0m\n`); // Prints in green
      console.log(`Copy this URL and use 'monolith env set DATABASE_URL=' to link it to your app.`);
      
    } catch (error) {
      console.error("❌ Failed to create database:", error.response?.data?.error || error.message);
    }
  });

program
  .command('init')
  .description('Initialize a new Monolith project in the current directory')
  .argument('<projectName>', 'name of the project')
  .action(async (projectName) => {
    const configDir = path.join(process.cwd(), '.monolith');
    const configFile = path.join(configDir, 'project.json');

    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    const projectId = `proj_${Math.random().toString(36).slice(-6)}`;
    const config = { name: projectName, id: projectId };

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    console.log(`✅ Project initialized: ${projectName} (${projectId})\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    // 1. Interactive Directory Routing
    let buildDir = await askQuestion('📂 Enter your build directory (e.g., backend, api) or press Enter for root: ');
    buildDir = buildDir.trim();

    let targetPackageDir = process.cwd();

    if (buildDir !== '') {
      const checkPath = path.join(process.cwd(), buildDir);
      if (fs.existsSync(checkPath)) {
        console.log(`\n📦 Generating monolith.json pointing to /${buildDir}...`);
        fs.writeFileSync(
          path.join(process.cwd(), 'monolith.json'), 
          JSON.stringify({ buildDirectory: buildDir }, null, 2)
        );
        targetPackageDir = checkPath;
      } else {
        console.log(`\n⚠️  Directory '${buildDir}' not found. Defaulting to root.`);
      }
    } else {
      console.log(`\n📦 Using root directory for deployment.`);
    }

    // 2. Edge-Case Tool Registry & Interactive Fallback
    const packageJsonPath = path.join(targetPackageDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      
      // Add known edge-cases here as your platform grows
      const KNOWN_TOOLS = {
        '@prisma/client': { name: 'Prisma ORM', command: 'npx prisma generate' },
        'puppeteer': { name: 'Puppeteer', command: 'npx puppeteer browsers install' }
      };

      pkg.scripts = pkg.scripts || {};
      let currentPostInstall = pkg.scripts.postinstall ? pkg.scripts.postinstall.split(' && ') : [];
      let modified = false;

      for (const [dep, config] of Object.entries(KNOWN_TOOLS)) {
        if (allDeps[dep] && !currentPostInstall.includes(config.command)) {
          const answer = await askQuestion(`\n⚠️  Detected ${config.name}. Add '${config.command}' to build step? (Y/n): `);
          if (answer.toLowerCase() !== 'n') {
            currentPostInstall.push(config.command);
            modified = true;
          }
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

program.parse(process.argv);