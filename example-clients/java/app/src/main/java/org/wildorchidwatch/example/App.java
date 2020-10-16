package org.wildorchidwatch.example;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.json.JSONObject;
import org.json.JSONArray;

public class App {
    public void getObservations() {
        final String clientApiKey = System.getenv("API_KEY");
        if (clientApiKey == null) {
            throw new RuntimeException("Env var API_KEY must be provided");
        }
        final int pageSize = 3;
        int page = 1;
        final int maxPages = 3;
        var isMorePages = true;
        final String url = "https://api-facade.wildorchidwatch.org/wow-observations"
            + "?per_page=" + pageSize;
        while (isMorePages) {
          var client = HttpClient.newHttpClient();
          System.out.println("Processing page " + page);
          var urlWithPage = url + "&page=" + page;
          var request = HttpRequest.newBuilder()
              .uri(URI.create(urlWithPage))
              .header("Authorization", clientApiKey)
              .build();
          try {
              var response = client.send(request, HttpResponse.BodyHandlers.ofString());
              var body = response.body();
              // System.out.println(body); // beware, it's a lot of text
              var jsonBody = new JSONObject(body);
              var totalResults = jsonBody.getInt("total_results");
              var results = jsonBody.getJSONArray("results");
              for (int i = 0; i < results.length(); i++) {
                  var curr = results.getJSONObject(i);
                  System.out.println("ID="+curr.get("id"));
                  // all observations submitted via the app will be obscured but
                  // users are free to add observations using other clients and
                  // these may not be obscured.
                  var location = curr.getBoolean("obscured") ?
                      // also see private_geojson for atomised data
                      curr.get("private_location") :
                      curr.get("location");
                  System.out.println("  datetime=" + curr.get("time_observed_at"));
                  System.out.println("  location=" + location);
                  System.out.println("  species=" + curr.get("species_guess"));
                  this.processObsFields(curr.getJSONArray("ofvs"));
              }
              isMorePages = page < maxPages && page * pageSize < totalResults;
              page += 1;
          } catch ( Exception e ) {
              throw new RuntimeException("Failed to make HTTP call", e);
          }
        }
    }

    void processObsFields(JSONArray ofvs) {
      int maxFieldsToShow = 2;
      for (int i = 0; i < 2; i++) {
        var curr = ofvs.getJSONObject(i);
        var name = curr.getString("name");
        var value = curr.getString("value");
        System.out.println("  " + name + "=" + value);
      }
    }

    public static void main(String[] args) {
        new App().getObservations();
    }
}
