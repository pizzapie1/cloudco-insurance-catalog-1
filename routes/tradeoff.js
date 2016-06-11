var tradeoffAnalytics = require('watson-developer-cloud').tradeoff_analytics(tradeoffService),
		db = require('./db');

//Create and populate or delete the database.
exports.evaluate = function(req, res) {

	// Get and validate policy calculation inputs
  var tripDuration = req.body.tripDuration,
      tripCost = req.body.tripCost,
      addTravelers = req.body.addTravelers,
      refund = req.body.refund,
      reviews = req.body.reviews,
      policyCost = req.body.policyCost;
  if (tripDuration === undefined || tripCost === undefined ||
  		(addTravelers && addTravelers.length === 0))
  	res.send({msg:'Error: Invalid criteria received for tradeoff calculation'});
  else {
    db.policiesDb.list({include_docs: true}, function(err, body) {
      if (err) {
        res.send({msg:'Error retrieving policies: ' + err});
      }
      else {
        // Get policies and winnow them down to eligible options based on input criteria
        var policies = getEligiblePolicies(body.rows, tripDuration, refund, reviews);
        var options = policies.map(function(policy) {
          return policyToOption(policy, tripDuration, addTravelers, tripCost);
        });
        if (policyCost)
          options = filterOptionsOnCost(options, policyCost);

        var problem = require("./tradeoff_data/policies.template.json");
        problem.options = options;

        // Call Tradeoff Analytics service
        tradeoffAnalytics.dilemmas(problem, function(err, data) {
          if (err)
            return res.send({msg:'Error calculating tradeoff analytics: ' + err});
          else {
            var answer = buildAnswer(data, policies);
            return res.json(answer);
          }
        });
      }
    });
  }
};


/**
 * Returns policies that are eligible given the input criteria
 */
function getEligiblePolicies(policyDocs, tripDuration, minRefund, minReview) {
  var eligiblePolicies = [];
  for (var policy in policyDocs) {
    // If policy exceeds minimum duration, offers a large enough
    // cancellation refund, and review high enough, it is eligible
    if (policyDocs[policy].doc.minDays <= tripDuration &&
        (!minRefund || policyDocs[policy].doc.cancelRefund >= minRefund) &&
        (!minReview || policyDocs[policy].doc.review >= minReview))
      eligiblePolicies.push(policyDocs[policy].doc);
  }

  return eligiblePolicies;
}


/**
 * Returns an option for input into the Tradeoff Analytics service
 */
function policyToOption(policyDoc, tripDuration, addTravelers, tripCost) {
  var option = {};
  option.key = policyDoc._id;
  option.name = policyDoc.name;

  // Calculate multiplier for additional travelers
  var addTravelerMult = 1;
  if (addTravelers && addTravelers.length > 0) {
    var baseTravelerMult = 1 + (policyDoc.perAddTraveler / 100);
    for (var addtl in addTravelers) {
      addTravelerMult *= baseTravelerMult;
    }
  }

  // Calculate multiplier for additional days
  var addDaysMult = 1;
  if (tripDuration > policyDoc.minDays && policyDoc.perAddDay > 0) {
    var addDays = tripDuration - policyDoc.minDays,
        baseAddDaysMult = 1 + (policyDoc.perAddDay / 100);
    for (var i=0; i < addDays; i++) {
      addDaysMult *= baseAddDaysMult;
    }
  }

  // Define tradeoff values 
  option.values = {};
  option.values.cost = Math.round(policyDoc.baseCost * addTravelerMult * addDaysMult);
  option.values.levelCare = policyDoc.levelCare;
  option.values.amount = Math.round(policyDoc.amount * option.values.cost);
  option.values.review = policyDoc.review;

  return option;
}


/**
 * Removes policy options that are too expensive per the user's input
 */
function filterOptionsOnCost(options, policyCost) {
  var validOptions = [];
  for (var policy in options) {
    if (options[policy].values.cost <= policyCost)
      validOptions.push(options[policy]);
  }

  return validOptions;
}


/**
 * Sorts and formats the resolutions returned from the TA service
 */
function buildAnswer(tradeoffResult, policies) {
  var orderedPolicies = [],
      solutionMap = new Map(),
      curSolution,
      values;

  // Iterate through the returned solutions to determine inclusion
  for (var solution in tradeoffResult.resolution.solutions) {
    curSolution = tradeoffResult.resolution.solutions[solution];
    // Put all valid solutions in a map with their ids and values
    if (curSolution.status === "FRONT") {
      solutionMap.set(curSolution.solution_ref,
                      tradeoffResult.problem.options[solution].values);
    }
  }

  // Populate returned list of policies
  for (var policy in policies) {
    curPolicy = policies[policy];
    // If policy is in the solution map, place in results array with values
    if (solutionMap.has(curPolicy._id)) {
      // Add calculated values
      values = solutionMap.get(curPolicy._id);
      curPolicy.cost = values.cost;
      curPolicy.coverage = values.amount;
      curPolicy.id = curPolicy._id;

      // Remove uneccesary values
      delete curPolicy._id;
      delete curPolicy._rev;
      delete curPolicy.baseCost;
      delete curPolicy.amount;
      delete curPolicy.perAddTraveler;
      delete curPolicy.perAddDay;

      orderedPolicies.push(curPolicy);
    }
  }

  return {
    columns: tradeoffResult.problem.columns,
    policies: sortPoliciesByKey(orderedPolicies, 'name'),
    map: tradeoffResult.resolution.map
  };
}

/**
 * Sorts an array of policies by the given key
 */
function sortPoliciesByKey(policies, key) {
  return policies.sort(function(a, b) {
    var x = a[key]; var y = b[key];
    return ((x < y) ? -1 : ((x > y) ? 1 : 0));
  });
}