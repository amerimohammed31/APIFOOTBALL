import axios from "axios";
import fs from "fs";
import path from "path";

const FILE_PATH = path.resolve("./match-today.json");
const BASE_API_URL = "https://www.footmercato.net/api/3.0";

// ================= دالة بسيطة لجلب البيانات =================
async function simpleFetch(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json"
      },
      timeout: 30000
    });
    return data;
  } catch (error) {
    console.log(`   ⚠️ فشل جلب ${url}: ${error.message}`);
    return null;
  }
}

// ================= MAIN =================
async function fetchAllData() {
  console.log("=".repeat(60));
  console.log("🚀 جلب بيانات المباريات (الإحصائيات والتشكيلة فقط)...");
  console.log("=".repeat(60));

  try {
    // 1. جلب الرابط الرئيسي
    console.log("📥 جلب: /match/");
    const mainData = await simpleFetch(`${BASE_API_URL}/match/`);
    
    if (!mainData) {
      console.log("❌ فشل جلب البيانات الرئيسية");
      return;
    }

    // 2. استخراج جميع أرقام المباريات
    const matchIds = new Set();
    
    if (mainData.components) {
      mainData.components.forEach(comp => {
        if (comp.name === "match/competitionMatches" && comp.data?.matches) {
          comp.data.matches.forEach(match => {
            if (match.id) matchIds.add(match.id.toString());
          });
        }
      });
    }

    const matchIdsArray = Array.from(matchIds);
    console.log(`📊 تم العثور على ${matchIdsArray.length} مباراة`);

    // 3. إنشاء الكائن النهائي
    const finalData = {
      metadata: {
        fetchedAt: new Date().toISOString(),
        totalMatches: matchIdsArray.length,
        baseUrl: BASE_API_URL
      },
      mainData: mainData, // البيانات الرئيسية كما هي
      matches: {} // سنضع بيانات المباريات هنا
    };

    // 4. جلب تفاصيل كل مباراة (الإحصائيات والتشكيلة فقط)
    console.log("\n📥 جلب الإحصائيات والتشكيلة للمباريات...");
    
    for (let i = 0; i < matchIdsArray.length; i++) {
      const matchId = matchIdsArray[i];
      console.log(`   [${i + 1}/${matchIdsArray.length}] المباراة: ${matchId}`);
      
      // جلب الإحصائيات
      const stats = await simpleFetch(`${BASE_API_URL}/match/${matchId}/stats`);
      
      // جلب التشكيلة
      const formation = await simpleFetch(`${BASE_API_URL}/match/${matchId}/formation`);
      
      // تخزين الإحصائيات والتشكيلة فقط
      finalData.matches[matchId] = {
        id: matchId,
        stats: stats,
        formation: formation,
        fetchedAt: new Date().toISOString()
      };
      
      // تأخير بسيط بين الطلبات (300ms)
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // 5. حفظ الملف
    fs.writeFileSync(FILE_PATH, JSON.stringify(finalData, null, 2), "utf8");
    
    console.log("\n" + "=".repeat(60));
    console.log("✅ تم الانتهاء بنجاح!");
    console.log("=".repeat(60));
    console.log(`📁 الملف: ${FILE_PATH}`);
    console.log(`📊 إجمالي المباريات: ${matchIdsArray.length}`);
    console.log(`📦 حجم الملف: ${(fs.statSync(FILE_PATH).size / 1024 / 1024).toFixed(2)} MB`);
    console.log("=".repeat(60));

  } catch (error) {
    console.error("❌ خطأ:", error.message);
  }
}

// ====== التشغيل ======
fetchAllData();