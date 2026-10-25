import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.util.*;
import org.opengrok.indexer.configuration.RuntimeEnvironment;
import org.opengrok.indexer.search.SearchEngine;
import org.opengrok.indexer.search.QueryBuilder;
import org.opengrok.indexer.search.Hit;

/** Uses OpenGrok's own SearchEngine, the same query layer used by its application. */
public class OpenGrokQuery {
    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("CONFIG QUESTIONS symbol|text");
        ObjectMapper mapper = new ObjectMapper();
        JsonNode questions = mapper.readTree(new File(args[1]));
        long start = System.nanoTime();
        RuntimeEnvironment environment = RuntimeEnvironment.getInstance();
        environment.readConfiguration(new File(args[0]));
        double loadMs = (System.nanoTime() - start) / 1e6;
        List<Object> rows = new ArrayList<>();
        int indexedDocuments = 0;
        for (JsonNode question : questions) {
            String query = question.get("query").asText();
            List<Double> timings = new ArrayList<>();
            List<Map<String, Object>> files = new ArrayList<>();
            double cold = 0;
            int total = 0;
            for (int n = 0; n < 21; n++) {
                long begin = System.nanoTime();
                SearchEngine engine = new SearchEngine(10);
                try {
                    if (args[2].equals("symbol")) engine.setDefinition(query);
                    else engine.setFreetext(query);
                    int count = engine.search();
                    if (engine.scoreDocs() == null) throw new IllegalStateException("Search failed: " + query);
                    indexedDocuments = engine.getSearcher().getIndexReader().numDocs();
                    files = new ArrayList<>();
                    for (var score : engine.scoreDocs()) {
                        String path = engine.doc(score.doc).get(QueryBuilder.PATH).replaceFirst("^/", "");
                        files.add(new LinkedHashMap<>(Map.of("path", path)));
                    }
                    double elapsed = (System.nanoTime() - begin) / 1e6;
                    if (n == 0) cold = elapsed; else timings.add(elapsed);
                    total = engine.getTotalHits();
                    if (n == 20) {
                        List<Hit> hits = new ArrayList<>();
                        engine.results(0, count, hits);
                        for (var file : files) {
                            List<Map<String, Object>> lines = new ArrayList<>();
                            for (Hit hit : hits) {
                                if (hit.getPath().replaceFirst("^/", "").equals(file.get("path")) && lines.size() < 3) {
                                    String number = Objects.toString(hit.getLineno(), "");
                                    lines.add(Map.of("line", number.matches("\\d+") ? Integer.parseInt(number) : 0, "source", Objects.toString(hit.getLine(), "")));
                                }
                            }
                            file.put("lines", lines);
                        }
                    }
                } finally { engine.destroy(); }
            }
            boolean hit = false;
            for (var file : files) for (JsonNode expected : question.path("expectedPaths"))
                if (file.get("path").equals(expected.asText())) hit = true;
            Collections.sort(timings);
            rows.add(Map.of("query", query, "hitAt10", hit, "coldMs", cold, "medianMs", (timings.get(9) + timings.get(10)) / 2, "totalFiles", total, "files", files));
        }
        mapper.writerWithDefaultPrettyPrinter().writeValue(System.out, Map.of("tool", "OpenGrok", "loadMs", loadMs, "mode", args[2], "warmup", 1, "repetitions", 20, "rows", rows, "indexedDocuments", indexedDocuments));
        environment.shutdownSearchExecutor();
        environment.shutdownRevisionExecutor();
        environment.shutdownDirectoryListingExecutor();
    }
}
