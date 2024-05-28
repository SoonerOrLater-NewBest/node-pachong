const puppeteer = require("puppeteer");
const xlsx = require("xlsx");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const ProgressBar = require("cli-progress");
const { promisify } = require("util");
const cluster = require("cluster");
const numCPUs = require("os").cpus().length;

const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);

// 获取当前日期并创建相应的文件夹
const currentDate = new Date().toISOString().slice(0, 10);
const baseDir = path.join(__dirname, currentDate);
const imagesDir = path.join(baseDir, "images");
const videosDir = path.join(baseDir, "videos");

// 创建文件夹
async function createDirectories() {
  await mkdir(baseDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });
  await mkdir(videosDir, { recursive: true });
}

// 创建 Excel 文件
function createExcelFile() {
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.aoa_to_sheet([
    ["标题", "缩略图", "更新状态", "最新一集播放链接"],
  ]);
  xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  const filePath = path.join(baseDir, "最新日漫.xlsx");
  xlsx.writeFile(workbook, filePath);
  return filePath;
}

// 更新 Excel 文件
function updateExcelFile(filePath, data) {
  const workbook = xlsx.readFile(filePath);
  const worksheet = workbook.Sheets["Sheet1"];
  xlsx.utils.sheet_add_aoa(worksheet, [data], { origin: -1 });
  xlsx.writeFile(workbook, filePath);
}

// 下载文件
async function downloadFile(url, filePath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
  });

  const writer = fs.createWriteStream(filePath);
  response.data.pipe(writer);

  const progressBar = new ProgressBar.SingleBar(
    {},
    ProgressBar.Presets.shades_classic
  );
  const totalLength = response.headers["content-length"];

  progressBar.start(totalLength, 0);

  response.data.on("data", (chunk) => progressBar.increment(chunk.length));
  response.data.on("end", () => progressBar.stop());

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// 子进程任务
async function processAnime(animeIndex) {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();

  // 设置用户代理
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.goto("https://www.857yhdm.com/type/ribendongman.html", {
    waitUntil: "domcontentloaded",
  });
  console.log(
    `子进程 ${animeIndex} - 网页已打开： https://www.857yhdm.com/type/ribendongman.html`
  );

  const animeList = await page.$$(".myui-vodlist__box");
  const anime = animeList[animeIndex];

  // 获取标题
  const titleElement = await anime.$("h4");
  const title = await (await titleElement.getProperty("title")).jsonValue();

  // 获取缩略图
  const thumbnailElement = await anime.$("a");
  const thumbnail = await (
    await thumbnailElement.getProperty("data-original")
  ).jsonValue();

  // 获取更新状态
  const statusElement = await anime.$(".pic-text.text-right");
  const status = await (
    await statusElement.getProperty("textContent")
  ).jsonValue();

  // 下载缩略图
  const imagePath = path.join(imagesDir, `${title}.jpg`);
  await downloadFile(thumbnail, imagePath);

  // 写入Excel文件
  updateExcelFile(excelFilePath, [title, thumbnail, status, ""]);

  // 进入详情页
  await thumbnailElement.click();
  await page.waitForNavigation({ waitUntil: "domcontentloaded" });
  console.log(`子进程 ${animeIndex} - 已进入详情页: ${title}`);

  // 获取最新一集播放链接
  const episodesList = await page.$$(
    ".myui-content__list.sort-list.clearfix a"
  );
  const latestEpisodeUrl =
    "https://www.857yhdm.com" +
    (await (
      await episodesList[episodesList.length - 1].getProperty("href")
    ).jsonValue());

  // 更新Excel文件
  updateExcelFile(excelFilePath, [null, null, null, latestEpisodeUrl]);

  // 进入播放页面
  await episodesList[episodesList.length - 1].click();
  await page.waitForNavigation({ waitUntil: "domcontentloaded" });
  console.log(`子进程 ${animeIndex} - 已进入播放页面: ${latestEpisodeUrl}`);

  // 获取视频链接并下载
  const iframe = await page.$("table iframe");
  const iframeSrc = await (await iframe.getProperty("src")).jsonValue();
  const iframePage = await browser.newPage();
  await iframePage.goto(iframeSrc, { waitUntil: "domcontentloaded" });

  const videoElement = await iframePage.$("#lelevideo");
  const videoSrc = await (await videoElement.getProperty("src")).jsonValue();

  const videoPath = path.join(videosDir, `${title}第${animeIndex + 1}集.mp4`);
  await downloadFile(videoSrc, videoPath);
  console.log(`子进程 ${animeIndex} - 视频已下载: ${videoPath}`);

  await iframePage.close();
  await browser.close();
}

if (cluster.isMaster) {
  // 主进程
  (async () => {
    await createDirectories();
    excelFilePath = createExcelFile();

    // 启动子进程
    for (let i = 0; i < Math.min(numCPUs, 5); i++) {
      cluster.fork({ animeIndex: i });
    }

    // 当所有子进程结束后退出主进程
    let finishedProcesses = 0;
    cluster.on("exit", (worker, code, signal) => {
      finishedProcesses += 1;
      if (finishedProcesses === Math.min(numCPUs, 5)) {
        console.log("所有子进程已完成");
        process.exit(0);
      }
    });
  })();
} else {
  // 子进程
  const animeIndex = parseInt(process.env.animeIndex, 10);
  processAnime(animeIndex)
    .then(() => {
      console.log(`子进程 ${animeIndex} 完成`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`子进程 ${animeIndex} 出错:`, err);
      process.exit(1);
    });
}
