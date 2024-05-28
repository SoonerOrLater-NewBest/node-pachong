const puppeteer = require("puppeteer");
const fs = require("fs");

(async () => {
  // 启动 Puppeteer 浏览器
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();

  // 设置用户代理和请求头来模拟真实用户
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.85 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "zh-CN,zh;q=0.9",
  });

  // 打开目标网页
  console.log("打开网页：https://www.857yhdm.com/type/ribendongman.html");
  await page.goto("https://www.857yhdm.com/type/ribendongman.html", {
    waitUntil: "networkidle2",
  });

  // 获取前 20 个 class="myui-vodlist__box" 的 div 标签
  const animeList = await page.$$eval(".myui-vodlist__box", (boxes) => {
    return Array.from(boxes)
      .slice(0, 20)
      .map((box) => {
        const titleElement = box.querySelector("h4 a");
        const imgElement = box.querySelector("a[data-original]");
        const statusElement = box.querySelector(".pic-text.text-right");
        return {
          title: titleElement ? titleElement.getAttribute("title") : "",
          thumbnail: imgElement ? imgElement.getAttribute("data-original") : "",
          updateStatus: statusElement ? statusElement.innerText.trim() : "",
          detailUrl: titleElement
            ? new URL(titleElement.href, "https://www.857yhdm.com").href
            : "",
        };
      });
  });

  // 存储JSON数据的数组
  let jsonData = [];

  // 循环处理每个动漫
  for (let i = 0; i < animeList.length; i++) {
    const anime = animeList[i];
    console.log(`处理第 ${i + 1} 个: ${anime.title}`);

    // 打开详情页
    await page.goto(anime.detailUrl, { waitUntil: "networkidle2" });

    // 获取最新一集播放链接
    const latestEpisodeLink = await page.$$eval(
      ".myui-content__list.sort-list.clearfix a",
      (links) => {
        const latestLink = links[links.length - 1];
        return latestLink
          ? `https://www.857yhdm.com${latestLink.getAttribute("href")}`
          : "";
      }
    );

    // 添加到JSON数据数组
    jsonData.push({
      title: anime.title,
      thumb: anime.thumbnail,
      status: anime.updateStatus,
      latestLink: latestEpisodeLink,
    });

    // 随机延迟请求，模拟人为操作
    await new Promise((resolve) =>
      setTimeout(resolve, Math.floor(Math.random() * 3000) + 1000)
    );
  }

  // 保存JSON文件
  const jsonFileName = "dongman.json";
  fs.writeFileSync(jsonFileName, JSON.stringify(jsonData, null, 2));
  console.log(`JSON文件已保存: ${jsonFileName}`);

  await browser.close();
})();
