import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.util.*;
import org.apache.lucene.index.MultiBits;
import org.opengrok.indexer.configuration.RuntimeEnvironment;
import org.opengrok.indexer.search.QueryBuilder;
import org.opengrok.indexer.search.SearchEngine;

/** Audit input coverage and distinguish absent definitions from top-ten ranking misses. */
public class OpenGrokAudit {
    public static void main(String[] args) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        Set<String> expected = new TreeSet<>();
        for (JsonNode file : mapper.readTree(new File(args[1]))) expected.add(file.get("path").asText());
        RuntimeEnvironment env = RuntimeEnvironment.getInstance();
        env.readConfiguration(new File(args[0]));
        Set<String> indexed = new TreeSet<>();
        List<Object> probes = new ArrayList<>();
        SearchEngine all = new SearchEngine(1);
        try {
            all.setFile("*");
            all.search();
            var reader = all.getSearcher().getIndexReader();
            var live = MultiBits.getLiveDocs(reader);
            var fields = reader.storedFields();
            for (int id = 0; id < reader.maxDoc(); id++) {
                if (live != null && !live.get(id)) continue;
                String path = fields.document(id, Set.of(QueryBuilder.PATH)).get(QueryBuilder.PATH);
                if (path != null) indexed.add(path.replaceFirst("^/", ""));
            }
        } finally { all.destroy(); }
        for (JsonNode question : mapper.readTree(new File(args[2]))) {
            for (JsonNode path : question.path("expectedPaths")) {
                SearchEngine scoped = new SearchEngine(10);
                try {
                    scoped.setDefinition(question.get("query").asText());
                    scoped.setFile(path.asText());
                    scoped.search();
                    List<String> matches = new ArrayList<>();
                    for (var score : scoped.scoreDocs()) matches.add(scoped.doc(score.doc).get(QueryBuilder.PATH).replaceFirst("^/", ""));
                    probes.add(Map.of("query", question.get("query").asText(), "expectedPath", path.asText(), "scopedMatch", matches.contains(path.asText()), "matches", matches));
                } finally { scoped.destroy(); }
            }
        }
        Set<String> missing = new TreeSet<>(expected); missing.removeAll(indexed);
        Set<String> additional = new TreeSet<>(indexed); additional.removeAll(expected);
        mapper.writerWithDefaultPrettyPrinter().writeValue(System.out, Map.of("inputFiles", expected.size(), "indexedInputFiles", expected.size() - missing.size(), "missingFiles", missing, "additionalDocuments", additional.size(), "definitionProbes", probes));
        env.shutdownSearchExecutor();
        env.shutdownRevisionExecutor();
        env.shutdownDirectoryListingExecutor();
    }
}
