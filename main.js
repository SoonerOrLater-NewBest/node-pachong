const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const os = require("os");
const path = require("path");
const fs = require("fs-extra");
const XLSX = require("xlsx");
const puppeteer = require("puppeteer");
const axios = require("axios");
const ProgressBar = require("progress");

const currentDate = new Date().toISOString().slice(0, 10);
const folderPath = path.join(__dirname, currentDate);
const imagePath = path.join(folderPath, "images");
const videoPath = path.join(folderPath, "videos");
const excelFilePath = path.join(folderPath, "最新日漫.xlsx");

if (isMainThread) {
  // 主线程
  (async () => {
    await fs.ensureDir(folderPath);
    await fs.ensureDir(imagePath);
    await fs.ensureDir(videoPath);

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["标题", "缩略图", "更新状态", "最新一集播放链接"],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "最新日漫");

    console.log("启动浏览器...");
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.85 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9" });

    console.log("打开网页：https://www.857yhdm.com/type/ribendongman.html");
    await page.goto("https://www.857yhdm.com/type/ribendongman.html", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    console.log("获取动画列表信息...");
    const animeList = await page.$$eval(".myui-vodlist__box", (boxes) => {
      return boxes.slice(0, 2).map((box, index) => {
        const titleElement = box.querySelector("h4 a");
        const imgElement = box.querySelector("a[data-original]");
        const statusElement = box.querySelector(".pic-text.text-right");
        return {
          index,
          title: titleElement ? titleElement.getAttribute("title") : "",
          thumbnail: imgElement ? imgElement.getAttribute("data-original") : "",
          updateStatus: statusElement ? statusElement.innerText : "",
          detailUrl: titleElement ? titleElement.href : "",
        };
      });
    });

    console.log("关闭浏览器...");
    await browser.close();

    const numCPUs = os.cpus().length;
    const chunkSize = Math.ceil(animeList.length / numCPUs);
    let promises = [];
    for (let i = 0; i < numCPUs; i++) {
      const chunk = animeList.slice(i * chunkSize, (i + 1) * chunkSize);
      promises.push(runWorker(chunk, i));
    }

    console.log("等待工作进程完成...");
    const results = await Promise.all(promises);
    const sortedResults = results.flat().sort((a, b) => a.index - b.index);

    console.log("将结果写入Excel文件...");
    sortedResults.forEach((row) => {
      XLSX.utils.sheet_add_json(worksheet, [row], {
        skipHeader: true,
        origin: -1,
      });
    });
    XLSX.writeFile(workbook, excelFilePath);
    console.log("Excel文件已保存:", excelFilePath);

    process.exit(0); // 确保所有进程关闭
  })();
} else {
  // 工作线程
  (async () => {
    const { animeList, workerIndex } = workerData;
    try {
      console.log(`启动工作进程 ${workerIndex}...`);
      const browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.85 Safari/537.36"
      );
      await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9" });

      let results = [];

      for (let i = 0; i < animeList.length; i++) {
        const anime = animeList[i];
        console.log(
          `Worker ${workerIndex} 处理第 ${anime.index + 1} 个: ${anime.title}`
        );
        try {
          // 下载缩略图
          const imageFileName = `${anime.title.replace(
            /[\/:*?"<>|]/g,
            "_"
          )}.jpg`;
          const imageFilePath = path.join(imagePath, imageFileName);
          const writer = fs.createWriteStream(imageFilePath);
          const response = await axios({
            url: anime.thumbnail,
            method: "GET",
            responseType: "stream",
          });
          response.data.pipe(writer);
          await new Promise((resolve, reject) => {
            writer.on("finish", () => {
              console.log("图片已下载：", imageFileName);
              return resolve();
            });
            writer.on("error", reject);
          });

          // 进入详情页
          await page.goto(anime.detailUrl, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });

          // 获取最新一集播放链接
          const latestEpisodeLinks = await page.$$eval(
            ".myui-content__list.sort-list.clearfix a",
            (links) =>
              links.map(
                (link) => `https://www.857yhdm.com${link.getAttribute("href")}`
              )
          );
          const latestEpisodeLink =
            latestEpisodeLinks[latestEpisodeLinks.length - 1];

          const row = {
            index: anime.index,
            标题: anime.title,
            缩略图: anime.thumbnail,
            更新状态: anime.updateStatus,
            最新一集播放链接: latestEpisodeLink,
          };
          results.push(row);

          // 进入最新一集播放页面
          await page.goto(latestEpisodeLink, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });

          // 获取视频播放页面中的iframe src
          await page.waitForSelector("table iframe", { timeout: 60000 });
          const iframeSrc = await page.$eval("table iframe", (iframe) =>
            iframe.getAttribute("src")
          );

          // 进入iframe页面
          await page.goto(iframeSrc, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });
          await page.waitForSelector("#lelevideo", { timeout: 60000 });

          const videoSrc = await page.$eval("#lelevideo", (video) =>
            video.getAttribute("src")
          );
          const videoFileName = `${anime.title.replace(
            /[\/:*?"<>|]/g,
            "_"
          )} 第${i + 1}集.mp4`;
          const videoFilePath = path.join(videoPath, videoFileName);

          console.log(`Worker ${workerIndex} 开始下载视频: ${videoSrc}`);

          const videoResponse = await axios({
            url: videoSrc,
            method: "GET",
            responseType: "stream",
          });
          const totalLength = parseInt(
            videoResponse.headers["content-length"],
            10
          );

          // 检查 content-length 是否存在
          if (!totalLength) {
            console.error(
              `Worker ${workerIndex} 下载 ${anime.title} 时未能获取 content-length`
            );
            continue;
          }

          const progressBar = new ProgressBar(
            `-> downloading [:bar] :percent :etas`,
            {
              width: 40,
              complete: "=",
              incomplete: " ",
              renderThrottle: 1,
              total: totalLength,
            }
          );

          const videoWriter = fs.createWriteStream(videoFilePath);
          videoResponse.data.on("data", (chunk) =>
            progressBar.tick(chunk.length)
          );
          videoResponse.data.pipe(videoWriter);

          await new Promise((resolve, reject) => {
            videoWriter.on("finish", () => {
              console.log(
                `Worker ${workerIndex} 视频下载完成: ${videoFilePath}`
              );
              resolve();
            });
            videoWriter.on("error", (error) => {
              console.error(
                `Worker ${workerIndex} 视频下载出错: ${error.message}`
              );
              reject(error);
            });
          });

          await page.waitForTimeout(Math.floor(Math.random() * 4000) + 1000); // 随机等待1-4秒
        } catch (error) {
          console.error(
            `Worker ${workerIndex} 处理第 ${anime.index + 1} 个时出错: ${
              error.message
            }`
          );
        }
      }

      await browser.close();
      parentPort.postMessage(results);
    } catch (error) {
      console.error(`Worker ${workerIndex} 遇到错误: ${error.message}`);
      parentPort.postMessage([]);
    }
    process.exit(0); // 确保进程正确关闭
  })();
}

// 运行工作线程
function runWorker(animeList, workerIndex) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { animeList, workerIndex },
    });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}
